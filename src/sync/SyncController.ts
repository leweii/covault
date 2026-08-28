/**
 * Background sync scheduling and per-repo state. Owns everything the user
 * sees about syncing (status bar text, notices); the GitEngine owns git.
 *
 * User-facing language here is knowledge-base vocabulary, never git.
 */
import { Notice } from "obsidian";
import * as path from "path";
import type { GitEngine, RepoRef, SyncResult } from "../git/GitEngine";
import type { ManifestRepo } from "../covault/manifest";
import type { ConflictResolver } from "../llm/resolver";
import type { DebugLog } from "../debug/logger";
import { applyResolutions, extractHunks, getContextLines, parseConflict, type HunkResolution } from "./ConflictParser";

/**
 * Last line of defence for one repo. The HTTP layer caps each request, but
 * a round is many requests plus local work, and a round that never ends
 * holds its repo's lock forever — every later sync of it would be handed
 * that same dead promise. A repo that outruns this is reported and let go.
 */
const REPO_TIMEOUT_MS = 10 * 60_000;

/** Below this AI confidence (0–5) a hunk is never auto-applied. */
const SILENT_MIN_CONFIDENCE = 3;

export type RepoPhase = "idle" | "syncing" | "conflict" | "error";

export interface RepoState {
  phase: RepoPhase;
  /** Human-readable detail for error/conflict states. */
  detail?: string;
  lastSyncedAt?: number;
}

/** One thing to sync: a shared library, or the main (vault-root) repo. */
export interface SyncItem extends ManifestRepo {
  /** Display name for notices/status (defaults to `path`). */
  label?: string;
  /** Extra paths excluded from change detection (main repo: the libraries). */
  exclude?: string[];
  /** Opt-in allowlist (main repo: only marked paths are shared). */
  include?: string[];
  /** Separate git directory, absolute (main repo: <vault>/.covault/main.git). */
  gitdir?: string;
  /** Never clone into this path (main repo: root always has content). */
  noAutoClone?: boolean;
}

export interface SyncHost {
  vaultBasePath(): string;
  repos(): SyncItem[];
  onStateChange(states: ReadonlyMap<string, RepoState>): void;
  /** Called once after every full sync pass (regardless of outcome). */
  onSyncPass?(): void;
}

export interface PendingConflict {
  item: SyncItem;
  filepaths: string[];
}

export class SyncController {
  private states = new Map<string, RepoState>();
  private pending = new Map<string, PendingConflict>();
  /**
   * One entry per repo currently syncing, keyed by its SyncItem path.
   *
   * Per repo rather than one global lock: two libraries are separate
   * working trees with separate git directories, so nothing is shared and
   * making one wait for the other only made the panel's per-row button
   * refuse to work. What must not overlap is the same repo with itself —
   * that is one index and one working tree.
   */
  private inFlight = new Map<string, Promise<void>>();
  /** What each in-flight round is and when it began, so the panel can name
   *  it. Holds setup work too, not just sync rounds. */
  private started = new Map<string, { at: number; label: string }>();
  /**
   * The pass currently sweeping every repo, if any.
   *
   * Passes exclude each other even though individual repos no longer do.
   * Letting an auto sweep, a manual sweep and the row buttons all overlap
   * put seven fetches on the wire at once, and since they share one
   * connection each got slower — median fetch went 16s → 60s and the
   * slowest crossed the request ceiling. One sweep, plus whatever the user
   * asks for by hand, is the useful amount of concurrency.
   */
  private pass: Promise<void> | null = null;

  constructor(
    private engine: GitEngine,
    private host: SyncHost,
    private resolver: ConflictResolver | null = null,
    private log: DebugLog | null = null,
  ) {}

  pendingConflicts(): PendingConflict[] {
    return [...this.pending.values()];
  }

  clearPending(repoPath: string): void {
    this.pending.delete(repoPath);
  }

  /**
   * Drop everything remembered about a repo — for a library being removed.
   * A stale error or conflict entry would otherwise hold the status bar on
   * "sync issue" or "needs attention" (and offer the conflict modal) for a
   * repo that no longer exists, until the plugin reloads.
   */
  forget(repoPath: string): void {
    const hadState = this.states.delete(repoPath);
    const hadPending = this.pending.delete(repoPath);
    if (hadState || hadPending) this.host.onStateChange(this.states);
  }

  state(repoPath: string): RepoState {
    return this.states.get(repoPath) ?? { phase: "idle" };
  }

  private setState(repoPath: string, state: RepoState): void {
    this.states.set(repoPath, state);
    this.host.onStateChange(this.states);
  }

  private toRef(repo: SyncItem): RepoRef {
    return {
      dir: path.join(this.host.vaultBasePath(), repo.path),
      url: repo.url,
      branch: repo.branch,
      gitdir: repo.gitdir,
    };
  }

  /** True while this repo is mid-sync — what the panel disables on. */
  isSyncing(repoPath: string): boolean {
    return this.inFlight.has(repoPath);
  }

  /**
   * What is syncing right now, for the panel. A long round used to be
   * invisible: the row's dot said "syncing" but not since when, and a
   * sweep working through fifteen libraries looked identical to a stuck
   * one.
   */
  activeTasks(): { repoPath: string; label: string; startedAt: number }[] {
    return [...this.started.entries()]
      .map(([repoPath, { at, label }]) => ({ repoPath, label, startedAt: at }))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Run non-sync work that owns a repo — setting up the personal knowledge
   * base, adopting a library's contents — under the same per-repo lock and
   * in the same task list.
   *
   * Both were invisible before: they go through the engine directly, so
   * the panel showed nothing while they ran, and nothing stopped a sync
   * round starting on the same repo underneath them.
   */
  async runExclusive<T>(repoPath: string, label: string, work: () => Promise<T>): Promise<T> {
    if (this.inFlight.has(repoPath)) {
      throw new Error(`"${label}" is already busy — wait for it to finish.`);
    }
    const done = this.log?.opTime("task", label, { repo: repoPath });
    const round = work();
    this.inFlight.set(
      repoPath,
      round.then(
        () => undefined,
        () => undefined,
      ),
    );
    this.started.set(repoPath, { at: Date.now(), label });
    this.host.onStateChange(this.states);
    try {
      return await round;
    } finally {
      this.inFlight.delete(repoPath);
      this.started.delete(repoPath);
      done?.();
      this.host.onStateChange(this.states);
    }
  }

  /** True while a full sweep is in progress. */
  isSweeping(): boolean {
    return this.pass !== null;
  }

  /**
   * Sync every configured repo, one after another.
   *
   * Sequential on purpose: fifteen simultaneous clones would thrash the
   * disk and the network for no gain on a background pass. A repo already
   * syncing on its own is skipped rather than queued — the round it is
   * running is the round this pass would have given it.
   */
  async syncAll(trigger: "manual" | "auto"): Promise<void> {
    if (this.pass) {
      this.log?.op("pass", "sweep skipped — one is already running", { trigger });
      return this.pass;
    }
    this.pass = this.runPass(trigger).finally(() => {
      this.pass = null;
    });
    return this.pass;
  }

  private async runPass(trigger: "manual" | "auto"): Promise<void> {
    const repos = this.host.repos();
    const done = this.log?.opTime("pass", "sync pass", { trigger, repos: repos.length });
    try {
      for (const repo of repos) {
        if (this.inFlight.has(repo.path)) {
          this.log?.op("pass", `skipped ${repo.label ?? repo.path} — already syncing`, { trigger });
          continue;
        }
        // The snapshot goes stale while the sweep runs: a library removed
        // mid-pass must not be synced from it — its folder was just deleted
        // or unlinked, and !isRepo would clone it right back.
        if (!this.host.repos().some((r) => r.path === repo.path)) {
          this.log?.op("pass", `skipped ${repo.label ?? repo.path} — removed while the sweep ran`, { trigger });
          continue;
        }
        await this.track(repo, trigger);
      }
    } finally {
      done?.();
      this.host.onSyncPass?.();
    }
  }

  /** Register a repo as in flight for the duration of its round. */
  private track(repo: SyncItem, trigger: "manual" | "auto"): Promise<void> {
    const round = this.syncOne(repo, trigger).finally(() => {
      this.inFlight.delete(repo.path);
      this.started.delete(repo.path);
      this.host.onStateChange(this.states); // the panel's task list shrank
    });
    this.inFlight.set(repo.path, round);
    this.started.set(repo.path, { at: Date.now(), label: repo.label ?? repo.path });
    return round;
  }

  /**
   * One repo, with a ceiling. Racing rather than cancelling: git work
   * already in flight cannot be called back, but the pass must not wait on
   * it forever.
   */
  /**
   * Sync one repo on its own, for the per-row button in the panel. Runs
   * alongside a pass or another repo; only the same repo twice is refused,
   * and then by awaiting the round already going rather than starting a
   * second one. `path` is the SyncItem key — "" is the personal repo.
   */
  async syncJust(repoPath: string): Promise<void> {
    const already = this.inFlight.get(repoPath);
    if (already) return already;
    const repo = this.host.repos().find((r) => r.path === repoPath);
    if (!repo) return;
    const done = this.log?.opTime("pass", "single sync", { repo: repo.label ?? repo.path });
    try {
      await this.track(repo, "manual");
    } finally {
      done?.();
      this.host.onSyncPass?.();
    }
  }

  private async syncOne(repo: SyncItem, trigger: "manual" | "auto"): Promise<void> {
    const ref = this.toRef(repo);
    const name = repo.label ?? repo.path;
    this.setState(repo.path, { phase: "syncing" });
    const done = this.log?.opTime("repo", name, { branch: ref.branch, trigger });
    let expiry: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.syncRepo(ref, repo, trigger, name),
        new Promise<never>((_resolve, reject) => {
          const tooLong = `took longer than ${REPO_TIMEOUT_MS / 60_000} minutes and was given up on`;
          expiry = setTimeout(() => reject(new Error(tooLong)), REPO_TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.setState(repo.path, { phase: "error", detail: message });
      console.error(`[covault] sync failed for ${name}:`, e);
      // The stack is the part a bug report needs and the Notice can't carry.
      this.log?.op("repo", `${name} — failed`, { error: e, stack: e instanceof Error ? e.stack : undefined });
      if (trigger === "manual") new Notice(`Covault: couldn't sync "${name}" — ${message}`);
    } finally {
      if (expiry) clearTimeout(expiry);
      done?.();
    }
  }

  /** One repo's round. Throws on failure; syncOne owns the reporting. */
  private async syncRepo(ref: RepoRef, repo: SyncItem, trigger: "manual" | "auto", name: string): Promise<void> {
    if (!(await this.engine.isRepo(ref))) {
      if (repo.noAutoClone) {
        this.setState(repo.path, { phase: "error", detail: "Needs set up again (repo state missing)" });
        return;
      }
      // An empty library (created on GitHub but never pushed to) has
      // nothing to clone — seed it from the vault folder instead.
      if (await this.engine.remoteHasBranch(ref)) {
        await this.engine.clone(ref);
      } else {
        await this.engine.initAndPush(ref, `Share ${name} as a knowledge library`);
      }
      this.setState(repo.path, { phase: "idle", lastSyncedAt: Date.now() });
      if (trigger === "manual") new Notice(`Covault: "${name}" is ready.`);
      return;
    }

    const result = await this.engine.syncToRemote(ref, {
      commitMessage: describeChanges, // placeholder — the agent takes this over in M4
      exclude: repo.exclude,
      include: repo.include,
    });

    if (result.conflictFilepaths.length > 0) {
      // First line of defense: the agent merges silently when confident.
      const auto = await this.tryAutoResolve(ref, result.conflictFilepaths);
      if (auto) {
        this.pending.delete(repo.path);
        this.setState(repo.path, { phase: "idle", lastSyncedAt: Date.now() });
        new Notice(
          `Covault: you and a teammate edited the same note(s) in "${name}" — ` +
            `the AI merged ${result.conflictFilepaths.length} of them automatically.`,
        );
        return;
      }

      this.pending.set(repo.path, { item: repo, filepaths: result.conflictFilepaths });
      this.setState(repo.path, {
        phase: "conflict",
        detail: `${result.conflictFilepaths.length} note(s) changed by you and a teammate`,
      });
      new Notice(
        `Covault: in "${name}", ${result.conflictFilepaths.length} note(s) need your input — ` +
          `run "Covault: Resolve conflicts" to sort them out.`,
        10_000,
      );
      return;
    }

    this.pending.delete(repo.path);
    this.setState(repo.path, { phase: "idle", lastSyncedAt: Date.now() });
    this.log?.op("repo", `${name} — ${summarize(result)}`, {
      committed: result.committed.length,
      pulled: result.pulled,
      pushed: result.pushed,
    });
    if (trigger === "manual") {
      new Notice(`Covault: "${name}" ${summarize(result)}.`);
    }
  }

  /**
   * Agent-first conflict handling: resolve every hunk of every conflicted
   * file, apply only if ALL hunks clear the confidence bar, then finish
   * the merge (stage, merge commit, push). Anything less leaves the
   * markers untouched for the ConflictModal.
   */
  private async tryAutoResolve(ref: RepoRef, filepaths: string[]): Promise<boolean> {
    if (!this.resolver?.isEnabled()) return false;
    try {
      const resolved: { path: string; content: string }[] = [];
      for (const filepath of filepaths) {
        const content = await this.engine.readWorkFile(ref, filepath);
        const segments = parseConflict(content);
        const hunks = extractHunks(segments);
        const resolutions = new Map<string, HunkResolution>();
        for (const hunk of hunks) {
          const { suggestion } = await this.resolver.suggest({
            filePath: filepath,
            hunk: { local: hunk.local, remote: hunk.remote },
            context: getContextLines(segments, hunk.id, 10),
          });
          if (suggestion.confidence < SILENT_MIN_CONFIDENCE) return false;
          resolutions.set(hunk.id, { kind: "edit", text: suggestion.merged.join("\n") });
        }
        resolved.push({ path: filepath, content: applyResolutions(segments, resolutions) });
      }
      for (const f of resolved) await this.engine.writeWorkFile(ref, f.path, f.content);
      await this.engine.completeMerge(ref, filepaths, `merge: AI auto-resolved ${filepaths.length} conflict(s)`);
      return true;
    } catch (e) {
      console.warn("[covault] AI auto-resolve failed, falling back to manual:", e);
      return false;
    }
  }
}

function describeChanges(changes: { filepath: string; kind: string }[]): string {
  const first = changes[0];
  if (!first) return "Update notes";
  const name = path.basename(first.filepath, ".md");
  return changes.length === 1 ? `Update ${name}` : `Update ${name} and ${changes.length - 1} more`;
}

function summarize(result: SyncResult): string {
  const parts: string[] = [];
  if (result.committed.length > 0) parts.push(`saved ${result.committed.length} change(s)`);
  if (result.pulled) parts.push("got teammates' updates");
  if (result.pushed) parts.push("shared yours");
  return parts.length > 0 ? parts.join(", ") : "is already up to date";
}

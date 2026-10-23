/**
 * Background sync scheduling and per-repo state. Owns everything the user
 * sees about syncing (status bar text, notices); the GitEngine owns git.
 *
 * User-facing language here is knowledge-base vocabulary, never git.
 */
import { Notice } from "obsidian";
import * as path from "path";
import type { ChangeKind, GitEngine, RepoRef, SyncResult } from "../git/GitEngine";
import type { ManifestRepo } from "../covault/manifest";
import type { ConflictResolver } from "../llm/resolver";
import type { DebugLog } from "../debug/logger";
import type { SyncRecord, SyncStatus } from "../debug/syncHistory";
import { applyResolutions, extractHunks, getContextLines, parseConflict, type HunkResolution } from "./ConflictParser";
import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from "node:timers";

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
  /** When this repo last synced cleanly; carried through every later
   *  phase, so "last success" is still known while it is failing. */
  lastSyncedAt?: number;
  /** Rounds failed in a row; back to 0 on the next clean sync. */
  failures?: number;
  /** How the last *finished* round ended — what the repo is while a new
   *  round runs and `phase` says "syncing". A failing library stays a
   *  failing library until a round succeeds, not until one starts. */
  lastOutcome?: "idle" | "error" | "conflict";
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
  /** Called after every repo round — clean, failed, or stopped on a conflict. */
  onRound?(record: SyncRecord): void;
}

/**
 * Teammates' changes to a repo that the user hasn't looked at yet,
 * accumulated across sync rounds until the panel shows them. In memory
 * only: after a restart the sync history file still has them.
 */
export interface UnseenUpdates {
  /** Path inside the repo → latest kind of change. */
  files: Map<string, ChangeKind>;
  /** Path inside the repo → the teammate credited with its latest change. */
  fileAuthors: Map<string, string>;
  authors: Set<string>;
  /** When the first unseen change arrived. */
  since: number;
}

export interface PendingConflict {
  item: SyncItem;
  filepaths: string[];
  /** Path → the teammate whose change collides with this device's, when
   *  the history made that out. Best effort; absent means "a teammate". */
  authors?: Record<string, string>;
}

export class SyncController {
  private states = new Map<string, RepoState>();
  private pending = new Map<string, PendingConflict>();
  private unseen = new Map<string, UnseenUpdates>();
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
    this.unseen.delete(repoPath);
    if (hadState || hadPending) this.host.onStateChange(this.states);
  }

  /** Teammates' changes not yet looked at, or null when there are none. */
  unseenUpdates(repoPath: string): UnseenUpdates | null {
    return this.unseen.get(repoPath) ?? null;
  }

  /** The user has seen them — the panel drops its badge. */
  markSeen(repoPath: string): void {
    if (this.unseen.delete(repoPath)) this.host.onStateChange(this.states);
  }

  private noteIncoming(repoPath: string, incoming: SyncResult["incoming"]): void {
    if (!incoming) return;
    const entry: UnseenUpdates = this.unseen.get(repoPath) ?? {
      files: new Map(),
      fileAuthors: new Map(),
      authors: new Set(),
      since: Date.now(),
    };
    for (const f of incoming.files) {
      // Added then deleted before anyone looked: nothing left to see.
      if (f.kind === "deleted" && entry.files.get(f.filepath) === "added") {
        entry.files.delete(f.filepath);
        entry.fileAuthors.delete(f.filepath);
        continue;
      }
      entry.files.set(f.filepath, entry.files.get(f.filepath) === "added" && f.kind === "modified" ? "added" : f.kind);
      if (f.author) entry.fileAuthors.set(f.filepath, f.author);
    }
    for (const a of incoming.authors) entry.authors.add(a);
    if (entry.files.size > 0) this.unseen.set(repoPath, entry);
    else this.unseen.delete(repoPath);
  }

  state(repoPath: string): RepoState {
    return this.states.get(repoPath) ?? { phase: "idle" };
  }

  /**
   * Replace a repo's phase, keeping what the phase doesn't say: when it
   * last synced cleanly, and how many rounds in a row have failed. A
   * failing library's "last success" would otherwise blank the moment a
   * retry started.
   */
  private setState(repoPath: string, state: RepoState): void {
    const prev = this.states.get(repoPath);
    const failures = state.phase === "error" ? (prev?.failures ?? 0) + 1 : state.phase === "idle" ? 0 : prev?.failures;
    const lastOutcome = state.phase === "syncing" ? (prev?.lastOutcome ?? "idle") : state.phase;
    this.states.set(repoPath, {
      lastSyncedAt: prev?.lastSyncedAt,
      ...state,
      ...(failures ? { failures } : {}),
      lastOutcome,
    });
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
    const startedAt = Date.now();
    const done = this.log?.opTime("repo", name, { branch: ref.branch, trigger });
    // Node timers, not window ones: no view owns this deadline — the sync
    // loop outlives every panel and popout — and the controller is
    // unit-tested headless, where there is no window to reach for.
    let expiry: NodeJS.Timeout | undefined;
    try {
      // An attachment backlog is worked through in budgeted rounds, each
      // with a fresh watchdog: the ceiling exists to catch a *stalled*
      // round, and a round that just shipped 256 MB isn't stalled. The
      // loop insists on progress — a pending count that stops shrinking
      // is a stall after all.
      let lastPending = Infinity;
      for (;;) {
        const pending = await Promise.race([
          this.syncRepo(ref, repo, trigger, name, startedAt),
          new Promise<never>((_resolve, reject) => {
            const tooLong = `took longer than ${REPO_TIMEOUT_MS / 60_000} minutes and was given up on`;
            expiry = setNodeTimeout(() => reject(new Error(tooLong)), REPO_TIMEOUT_MS);
          }),
        ]);
        if (expiry) clearNodeTimeout(expiry);
        if (pending === 0) break;
        if (pending >= lastPending) {
          throw new Error(`attachment uploads stopped making progress (${pending} left)`);
        }
        lastPending = pending;
        this.log?.op("repo", `${name} — attachments still uploading, next round`, { pending });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.setState(repo.path, { phase: "error", detail: message });
      console.error(`[covault] sync failed for ${name}:`, e);
      // The stack is the part a bug report needs and the Notice can't carry.
      this.log?.op("repo", `${name} — failed`, { error: e, stack: e instanceof Error ? e.stack : undefined });
      this.host.onRound?.({
        at: Date.now(),
        library: name,
        repoPath: repo.path,
        trigger,
        status: "error",
        summary: `failed — ${message}`,
        error: message,
        files: [],
        ms: Date.now() - startedAt,
      });
      if (trigger === "manual") new Notice(`Covault: couldn't sync "${name}" — ${message}`);
    } finally {
      if (expiry) clearNodeTimeout(expiry);
      done?.();
    }
  }

  /** One repo's round. Throws on failure; syncOne owns the reporting.
   *  Returns the number of LFS objects still to upload (0 = round done). */
  private async syncRepo(
    ref: RepoRef,
    repo: SyncItem,
    trigger: "manual" | "auto",
    name: string,
    startedAt: number,
  ): Promise<number> {
    const round = (
      status: SyncStatus,
      summary: string,
      files: SyncResult["committed"] = [],
      incoming: SyncResult["incoming"] = null,
      error?: string,
    ) =>
      this.host.onRound?.({
        at: Date.now(),
        library: name,
        repoPath: repo.path,
        trigger,
        status,
        summary,
        ...(error ? { error } : {}),
        files,
        incoming,
        ms: Date.now() - startedAt,
      });
    const synced = (summary: string, files: SyncResult["committed"] = [], incoming: SyncResult["incoming"] = null) =>
      round("ok", summary, files, incoming);
    if (!(await this.engine.isRepo(ref))) {
      if (repo.noAutoClone) {
        const detail = "Needs set up again (repo state missing)";
        this.setState(repo.path, { phase: "error", detail });
        round("error", `failed — ${detail}`, [], null, detail);
        return 0;
      }
      // An empty library (created on GitHub but never pushed to) has
      // nothing to clone — seed it from the vault folder instead.
      if (await this.engine.remoteHasBranch(ref)) {
        await this.engine.clone(ref);
      } else {
        await this.engine.initAndPush(ref, `Share ${name} as a knowledge library`);
      }
      this.setState(repo.path, { phase: "idle", lastSyncedAt: Date.now() });
      synced("set up on this device");
      if (trigger === "manual") new Notice(`Covault: "${name}" is ready.`);
      return 0;
    }

    const result = await this.engine.syncToRemote(ref, {
      commitMessage: describeChanges, // placeholder — the agent takes this over in M4
      exclude: repo.exclude,
      include: repo.include,
    });
    // Recorded whatever the round goes on to do: a merge whose push is
    // deferred (attachments still uploading) has still changed the tree.
    this.noteIncoming(repo.path, result.incoming);

    if (result.conflictFilepaths.length > 0) {
      // First line of defense: the agent merges silently when confident.
      const auto = await this.tryAutoResolve(ref, result.conflictFilepaths);
      if (auto) {
        this.pending.delete(repo.path);
        this.setState(repo.path, { phase: "idle", lastSyncedAt: Date.now() });
        synced(`AI merged ${result.conflictFilepaths.length} conflicting note(s)`, result.committed);
        new Notice(
          `Covault: you and a teammate edited the same note(s) in "${name}" — ` +
            `the AI merged ${result.conflictFilepaths.length} of them automatically.`,
        );
        return 0;
      }

      this.pending.set(repo.path, {
        item: repo,
        filepaths: result.conflictFilepaths,
        authors: await this.conflictAuthors(ref, result.conflictFilepaths),
      });
      this.setState(repo.path, {
        phase: "conflict",
        detail: `${result.conflictFilepaths.length} note(s) changed by you and a teammate`,
      });
      round("conflict", `${result.conflictFilepaths.length} note(s) need your input`, result.committed, result.incoming);
      new Notice(
        `Covault: in "${name}", ${result.conflictFilepaths.length} note(s) need your input — ` +
          `run "Covault: Resolve conflicts" to sort them out.`,
        10_000,
      );
      return 0;
    }

    if (result.lfsPending > 0) {
      // Mid-backlog: the round shipped its budget and deferred the push.
      // Stay in "syncing" — syncOne immediately runs the next round.
      if (trigger === "manual") {
        new Notice(`Covault: "${name}" is uploading attachments — ${result.lfsPending} to go…`);
      }
      return result.lfsPending;
    }

    this.pending.delete(repo.path);
    this.setState(repo.path, { phase: "idle", lastSyncedAt: Date.now() });
    this.log?.op("repo", `${name} — ${summarize(result)}`, {
      committed: result.committed.length,
      pulled: result.pulled,
      pushed: result.pushed,
    });
    synced(summarize(result), result.committed, result.incoming);
    if (trigger === "manual") {
      new Notice(`Covault: "${name}" ${summarize(result)}.`);
    }
    return 0;
  }

  /**
   * Who changed each conflicting note on the remote side — the commits
   * GitHub has that this device's branch doesn't. Best effort: it only
   * names the teammate in the conflict card, so any failure means the
   * card says "a teammate" instead.
   */
  private async conflictAuthors(ref: RepoRef, filepaths: string[]): Promise<Record<string, string> | undefined> {
    try {
      const { local, remote } = await this.engine.refOids(ref);
      if (!remote) return undefined;
      const credits = await this.engine.changesInRange(ref, local, remote);
      const authors: Record<string, string> = {};
      for (const c of credits) if (filepaths.includes(c.filepath)) authors[c.filepath] = c.author;
      return Object.keys(authors).length > 0 ? authors : undefined;
    } catch {
      return undefined;
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

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
import { applyResolutions, extractHunks, getContextLines, parseConflict, type HunkResolution } from "./ConflictParser";

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
}

export interface PendingConflict {
  item: SyncItem;
  filepaths: string[];
}

export class SyncController {
  private states = new Map<string, RepoState>();
  private pending = new Map<string, PendingConflict>();
  private running = false;

  constructor(
    private engine: GitEngine,
    private host: SyncHost,
    private resolver: ConflictResolver | null = null,
  ) {}

  pendingConflicts(): PendingConflict[] {
    return [...this.pending.values()];
  }

  clearPending(repoPath: string): void {
    this.pending.delete(repoPath);
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

  /** Sync every configured library. Serialized; a second call while one
   *  is running is a no-op (the running pass already covers it). */
  async syncAll(trigger: "manual" | "auto"): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const repo of this.host.repos()) {
        await this.syncOne(repo, trigger);
      }
    } finally {
      this.running = false;
    }
  }

  private async syncOne(repo: SyncItem, trigger: "manual" | "auto"): Promise<void> {
    const ref = this.toRef(repo);
    const name = repo.label ?? repo.path;
    this.setState(repo.path, { phase: "syncing" });
    try {
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
      if (trigger === "manual") {
        new Notice(`Covault: "${name}" ${summarize(result)}.`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.setState(repo.path, { phase: "error", detail: message });
      console.error(`[covault] sync failed for ${name}:`, e);
      if (trigger === "manual") new Notice(`Covault: couldn't sync "${name}" — ${message}`);
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

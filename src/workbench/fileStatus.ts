/**
 * Every synced file's standing, kept current while a workbench is open.
 *
 * Per repo, four sources merge into one status per file (model.ts):
 * the sync controller's conflicts and unseen teammate changes, the
 * engine's working-tree changes (edited here), and the commits this
 * device has that GitHub hasn't (saved, not uploaded). Recomputing a
 * repo costs one status walk of its tree, so it is debounced, done per
 * repo, and never while that repo is mid-round — a merge writes files
 * as it goes and would show as a flurry of ↑/↓; the round's end recomputes.
 *
 * Dependencies are injected, so the merge and scheduling logic runs in
 * tests without Obsidian or git.
 */
import type { GitEngine, LocalChange, RepoRef } from "../git/GitEngine";
import type { RepoState, SyncController, SyncItem } from "../sync/SyncController";
import { countStatuses, repoFileEntries, type FileEntry, type StatusCounts } from "./model";

export interface FileStatusDeps {
  items: () => SyncItem[];
  toRef: (item: SyncItem) => RepoRef;
  engine: Pick<GitEngine, "isRepo" | "localChanges" | "refOids" | "changesInRange">;
  sync: Pick<SyncController, "pendingConflicts" | "unseenUpdates" | "isSyncing">;
  /** Files on disk inside the repo, repo-relative (from the vault index). */
  listFiles: (item: SyncItem) => string[];
  log?: (message: string, data?: Record<string, unknown>) => void;
  /** Debounce for vault events; tests shrink it. */
  debounceMs?: number;
  /** Timer source — the window's in the plugin, Node's in tests. */
  timers?: Timers;
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const DEFAULT_DEBOUNCE_MS = 800;
const windowTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (handle) => window.clearTimeout(handle as number),
};

export class FileStatusIndex {
  private entries = new Map<string, FileEntry[]>();
  private timers = new Map<string, unknown>();
  private running = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  /** Repos whose recompute waits for their round to end. */
  private deferred = new Set<string>();
  private wasSyncing = new Set<string>();
  private listeners = new Set<() => void>();
  private disposed = false;

  constructor(private deps: FileStatusDeps) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  entriesFor(repoPath: string): FileEntry[] {
    return this.entries.get(repoPath) ?? [];
  }

  all(): FileEntry[] {
    return [...this.entries.values()].flat();
  }

  counts(): StatusCounts {
    return countStatuses(this.all().map((e) => e.status));
  }

  /** Has this repo been computed at least once? (Before that, show nothing rather than zeros.) */
  has(repoPath: string): boolean {
    return this.entries.has(repoPath);
  }

  /** Recompute every repo now — the workbench just opened. */
  refreshAll(): void {
    for (const item of this.deps.items()) this.invalidate(item.path, true);
    // Repos that no longer exist drop out.
    const live = new Set(this.deps.items().map((i) => i.path));
    for (const key of [...this.entries.keys()]) if (!live.has(key)) this.entries.delete(key);
  }

  /** A file changed on disk — the owning repo recomputes after a pause. */
  fileChanged(vaultPath: string): void {
    const owner = this.ownerOf(vaultPath);
    if (owner !== null) this.invalidate(owner);
  }

  /** Sync state moved: repos that just finished a round recompute at once. */
  syncStatesChanged(states: ReadonlyMap<string, RepoState>): void {
    const nowSyncing = new Set<string>();
    for (const [path, state] of states) if (state.phase === "syncing") nowSyncing.add(path);
    for (const path of this.wasSyncing) {
      if (!nowSyncing.has(path)) {
        this.deferred.delete(path);
        this.invalidate(path, true);
      }
    }
    // Conflicts and unseen changes live in the controller: a state change
    // can alter them without any file changing.
    for (const [path] of states) if (!nowSyncing.has(path) && !this.wasSyncing.has(path)) this.invalidate(path, true);
    this.wasSyncing = nowSyncing;
  }

  /** Teammates' changes were looked at — their ↓ marks go. */
  markedSeen(repoPath: string): void {
    this.invalidate(repoPath, true);
  }

  invalidate(repoPath: string, immediate = false): void {
    if (this.disposed) return;
    if (this.deps.sync.isSyncing(repoPath)) {
      this.deferred.add(repoPath);
      return;
    }
    const t = this.deps.timers ?? windowTimers;
    const pending = this.timers.get(repoPath);
    if (pending !== undefined) t.clear(pending);
    if (immediate) {
      this.timers.delete(repoPath);
      void this.compute(repoPath);
      return;
    }
    this.timers.set(
      repoPath,
      t.set(() => {
        this.timers.delete(repoPath);
        void this.compute(repoPath);
      }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS),
    );
  }

  dispose(): void {
    this.disposed = true;
    const t = this.deps.timers ?? windowTimers;
    for (const handle of this.timers.values()) t.clear(handle);
    this.timers.clear();
    this.listeners.clear();
  }

  private ownerOf(vaultPath: string): string | null {
    const items = this.deps.items();
    const lib = items.filter((i) => i.path && (vaultPath === i.path || vaultPath.startsWith(`${i.path}/`)));
    if (lib.length > 0) return lib.sort((a, b) => b.path.length - a.path.length)[0]!.path;
    return items.some((i) => i.path === "") ? "" : null;
  }

  private compute(repoPath: string): Promise<void> {
    const inFlight = this.running.get(repoPath);
    if (inFlight) {
      this.dirty.add(repoPath);
      return inFlight;
    }
    const run = this.computeNow(repoPath).finally(() => {
      this.running.delete(repoPath);
      if (this.dirty.delete(repoPath) && !this.disposed) void this.compute(repoPath);
    });
    this.running.set(repoPath, run);
    return run;
  }

  private async computeNow(repoPath: string): Promise<void> {
    const item = this.deps.items().find((i) => i.path === repoPath);
    if (!item) {
      if (this.entries.delete(repoPath)) this.emit();
      return;
    }
    const started = Date.now();
    const ref = this.deps.toRef(item);
    const present = this.deps.listFiles(item);
    let local: LocalChange[] = [];
    let pending: LocalChange[] = [];
    try {
      if (await this.deps.engine.isRepo(ref)) {
        const excluded = item.exclude ?? [];
        local = (await this.deps.engine.localChanges(ref, { exclude: item.exclude, include: item.include })).filter(
          (c) =>
            c.filepath !== ".covault/covault.json" &&
            // Index-only deletions under an excluded folder: a note that now
            // lives in a library, not something gone from this repo.
            !(c.kind === "deleted" && excluded.some((p) => c.filepath === p || c.filepath.startsWith(`${p}/`))),
        );
        const oids = await this.deps.engine.refOids(ref);
        if (oids.local && oids.remote && oids.local !== oids.remote) {
          pending = (await this.deps.engine.changesInRange(ref, oids.remote, oids.local)).map((c) => ({ filepath: c.filepath, kind: c.kind }));
        }
      }
    } catch (e) {
      this.deps.log?.(`status index — ${item.label ?? (item.path || "vault")} failed`, { error: e });
    }
    const conflict = this.deps.sync.pendingConflicts().find((p) => p.item.path === repoPath)?.filepaths ?? [];
    const unseen = this.deps.sync.unseenUpdates(repoPath);
    const incoming = unseen
      ? [...unseen.files.entries()].map(([filepath, kind]) => ({ filepath, kind, author: unseen.fileAuthors.get(filepath) }))
      : [];
    if (this.disposed) return;
    this.entries.set(repoPath, repoFileEntries({ repoPath, present, conflict, local, pending, incoming }));
    this.deps.log?.(`status index — ${item.label ?? (item.path || "vault")}`, {
      ms: Date.now() - started,
      files: present.length,
      local: local.length,
      pending: pending.length,
      incoming: incoming.length,
      conflict: conflict.length,
    });
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

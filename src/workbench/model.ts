/**
 * The workbench's view model, as pure functions: what a file's sync
 * status is, how statuses roll up into folder badges and the header
 * counters, which rows a filter keeps, and how libraries are ordered.
 *
 * Kept free of Obsidian and git so every rule here is unit-tested; the
 * view layer only renders what these return.
 */
import type { ChangeKind, LocalChange } from "../git/GitEngine";
import type { RepoPhase } from "../sync/SyncController";

/**
 * One file's standing against the team:
 *  - conflict  you and a teammate changed the same part; needs a decision
 *  - local     edited on this device, not yet saved by a sync
 *  - pending   saved (committed) here, not yet on GitHub — a push failed
 *              or attachments are still uploading
 *  - incoming  a teammate's change arrived and hasn't been looked at
 *  - synced    the same everywhere
 */
export type FileSyncStatus = "synced" | "local" | "pending" | "incoming" | "conflict";

const PRIORITY: Record<FileSyncStatus, number> = { conflict: 4, local: 3, pending: 2, incoming: 1, synced: 0 };

/** The status that matters more when a file has two. */
export function strongerStatus(a: FileSyncStatus, b: FileSyncStatus): FileSyncStatus {
  return PRIORITY[a] >= PRIORITY[b] ? a : b;
}

/** User-facing words for each status — knowledge-base vocabulary, never git. */
export const STATUS_TEXT: Record<FileSyncStatus, { mark: string; label: string; desc: string }> = {
  synced: { mark: "✓", label: "Shared, up to date", desc: "This note is on GitHub and matches the latest version from your teammates." },
  local: { mark: "●", label: "Changed here, not shared yet", desc: "You edited this note. It will be saved and shared on the next sync." },
  pending: { mark: "↑", label: "Saved, waiting to upload", desc: "Your change is saved on this device and will be uploaded on the next sync." },
  incoming: { mark: "↓", label: "New from teammates", desc: "A teammate changed this note; the latest version is already in your vault." },
  conflict: { mark: "!", label: "Needs your input", desc: "You and a teammate changed the same part of this note." },
};

export interface FileEntry {
  /** Vault-relative path. */
  path: string;
  /** Owning SyncItem path ("" = personal knowledge base). */
  repoPath: string;
  /** Path inside the repo. */
  rel: string;
  status: FileSyncStatus;
  /** What kind of change put it in that status (not for synced). */
  kind?: ChangeKind;
  /** The teammate credited with an incoming change. */
  author?: string;
  /** Gone from disk but still known to git — shown struck through. */
  ghost?: boolean;
}

export interface RepoStatusInput {
  repoPath: string;
  /** Files that exist on disk inside the repo, repo-relative. */
  present: string[];
  /** Files stopped on a merge conflict. */
  conflict: string[];
  /** Working tree vs. last save. */
  local: LocalChange[];
  /** Saved here, not on GitHub. */
  pending: LocalChange[];
  /** Teammates' changes not looked at yet. */
  incoming: { filepath: string; kind: ChangeKind; author?: string }[];
}

/** Every file of one repo with its status, deleted-but-tracked ones included. */
export function repoFileEntries(input: RepoStatusInput): FileEntry[] {
  const toPath = (rel: string) => (input.repoPath ? `${input.repoPath}/${rel}` : rel);
  const byRel = new Map<string, FileEntry>();
  for (const rel of input.present) byRel.set(rel, { path: toPath(rel), repoPath: input.repoPath, rel, status: "synced" });
  const overlay = (rel: string, status: FileSyncStatus, kind?: ChangeKind, author?: string) => {
    const existing = byRel.get(rel);
    const stronger = existing ? strongerStatus(existing.status, status) : status;
    if (existing && stronger !== status) return; // something more important already said so
    byRel.set(rel, {
      path: toPath(rel),
      repoPath: input.repoPath,
      rel,
      status,
      ...(kind ? { kind } : {}),
      ...(author ? { author } : {}),
      ...(!input.present.includes(rel) ? { ghost: true } : {}),
    });
  };
  // Weakest first, so a stronger status wins when a file has several.
  for (const f of input.incoming) overlay(f.filepath, "incoming", f.kind, f.author);
  for (const f of input.pending) overlay(f.filepath, "pending", f.kind);
  for (const f of input.local) overlay(f.filepath, "local", f.kind);
  for (const rel of input.conflict) overlay(rel, "conflict");
  return [...byRel.values()];
}

/** The header's filter chips. "local" covers pending too: both mean "not shared yet". */
export type SyncFilter = "all" | "conflict" | "local" | "incoming";

export function matchesSyncFilter(status: FileSyncStatus, filter: SyncFilter): boolean {
  if (filter === "all") return true;
  if (filter === "local") return status === "local" || status === "pending";
  return status === filter;
}

/** What the header counts; `local` includes pending. */
export interface StatusCounts {
  conflict: number;
  local: number;
  incoming: number;
  synced: number;
}

export const EMPTY_COUNTS: StatusCounts = { conflict: 0, local: 0, incoming: 0, synced: 0 };

export function countStatuses(statuses: Iterable<FileSyncStatus>): StatusCounts {
  const c = { ...EMPTY_COUNTS };
  for (const s of statuses) {
    if (s === "pending") c.local++;
    else c[s]++;
  }
  return c;
}

function addCounts(into: StatusCounts, from: StatusCounts): void {
  into.conflict += from.conflict;
  into.local += from.local;
  into.incoming += from.incoming;
  into.synced += from.synced;
}

export interface TreeNode {
  name: string;
  /** Vault-relative path of the folder or file. */
  path: string;
  kind: "dir" | "file";
  children: TreeNode[];
  entry?: FileEntry;
  /** This file's status, or the roll-up of everything below a folder. */
  counts: StatusCounts;
}

/**
 * A folder tree for one repo: folders first, then files, both by name;
 * every folder carries the counts of what's inside it (the badges).
 */
export function buildTree(rootPath: string, rootName: string, entries: FileEntry[]): TreeNode {
  const root: TreeNode = { name: rootName, path: rootPath, kind: "dir", children: [], counts: { ...EMPTY_COUNTS } };
  const dirs = new Map<string, TreeNode>([[rootPath, root]]);
  const dirFor = (relDir: string): TreeNode => {
    const full = rootPath ? (relDir ? `${rootPath}/${relDir}` : rootPath) : relDir;
    const found = dirs.get(full);
    if (found) return found;
    const slash = relDir.lastIndexOf("/");
    const parent = dirFor(slash >= 0 ? relDir.slice(0, slash) : "");
    const node: TreeNode = { name: relDir.slice(slash + 1), path: full, kind: "dir", children: [], counts: { ...EMPTY_COUNTS } };
    parent.children.push(node);
    dirs.set(full, node);
    return node;
  };
  for (const e of entries) {
    const slash = e.rel.lastIndexOf("/");
    const dir = dirFor(slash >= 0 ? e.rel.slice(0, slash) : "");
    const counts = countStatuses([e.status]);
    dir.children.push({ name: e.rel.slice(slash + 1), path: e.path, kind: "file", children: [], entry: e, counts });
  }
  const finish = (node: TreeNode): StatusCounts => {
    node.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.kind === "dir" ? -1 : 1));
    for (const child of node.children) {
      if (child.kind === "dir") finish(child);
      addCounts(node.counts, child.counts);
    }
    return node.counts;
  };
  finish(root);
  return root;
}

/** The tree with only the files `keep` accepts, and no empty folders. */
export function pruneTree(node: TreeNode, keep: (entry: FileEntry) => boolean): TreeNode | null {
  if (node.kind === "file") return node.entry && keep(node.entry) ? node : null;
  const children = node.children.map((c) => pruneTree(c, keep)).filter((c): c is TreeNode => c !== null);
  if (children.length === 0) return null;
  const counts = { ...EMPTY_COUNTS };
  for (const c of children) addCounts(counts, c.counts);
  return { ...node, children, counts };
}

/** Libraries with problems come first in the collapsed strip. */
export function repoRank(phase: RepoPhase): number {
  return { error: 0, conflict: 1, syncing: 2, idle: 3 }[phase];
}

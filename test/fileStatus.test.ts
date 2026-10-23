import { describe, expect, it, vi } from "vitest";
import { FileStatusIndex, type FileStatusDeps } from "../src/workbench/fileStatus";
import type { SyncItem } from "../src/sync/SyncController";

const lib: SyncItem = { path: "teams/kb", url: "u", branch: "main" };
const personal: SyncItem = { path: "", url: "u", branch: "main", label: "Personal knowledge base", exclude: ["teams/kb"], gitdir: "/v/.covault/main.git" };

function deps(overrides: Partial<FileStatusDeps> = {}) {
  const syncing = new Set<string>();
  const d: FileStatusDeps = {
    items: () => [personal, lib],
    toRef: (item) => ({ dir: `/v/${item.path}`, url: item.url, branch: item.branch, gitdir: item.gitdir }),
    engine: {
      isRepo: async () => true,
      localChanges: async () => [],
      refOids: async () => ({ head: "a", local: "a", remote: "a" }),
      changesInRange: async () => [],
    },
    sync: { pendingConflicts: () => [], unseenUpdates: () => null, isSyncing: (p) => syncing.has(p) },
    listFiles: (item) => (item.path ? ["README.md", "a.md"] : ["Inbox/x.md"]),
    debounceMs: 5,
    ...overrides,
  };
  return { d, syncing };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("FileStatusIndex", () => {
  it("merges conflicts, local edits, unpushed commits and teammates' changes per repo", async () => {
    const { d } = deps({
      engine: {
        isRepo: async () => true,
        localChanges: async (ref) => (ref.dir.endsWith("teams/kb") ? [{ filepath: "a.md", kind: "modified" }] : []),
        refOids: async (ref) => (ref.dir.endsWith("teams/kb") ? { head: "b", local: "b", remote: "a" } : { head: "a", local: "a", remote: "a" }),
        changesInRange: async () => [{ filepath: "README.md", kind: "modified", author: "me", authorEmail: "m", at: 1, commit: "b" }],
      },
      sync: {
        pendingConflicts: () => [],
        unseenUpdates: (p) =>
          p === "teams/kb" ? { files: new Map([["new.md", "added"]]), fileAuthors: new Map([["new.md", "Bob"]]), authors: new Set(["Bob"]), since: 1 } : null,
        isSyncing: () => false,
      },
    });
    const index = new FileStatusIndex(d);
    index.refreshAll();
    await settle();
    const byRel = Object.fromEntries(index.entriesFor("teams/kb").map((e) => [e.rel, e]));
    expect(byRel["a.md"]!.status).toBe("local");
    expect(byRel["README.md"]!.status).toBe("pending");
    expect(byRel["new.md"]).toMatchObject({ status: "incoming", author: "Bob", ghost: true });
    expect(index.entriesFor("")[0]).toMatchObject({ path: "Inbox/x.md", status: "synced" });
    expect(index.counts()).toEqual({ conflict: 0, local: 2, incoming: 1, synced: 1 });
  });

  it("drops bookkeeping and index-only deletions under an excluded library from the personal KB", async () => {
    const { d } = deps({
      engine: {
        isRepo: async () => true,
        localChanges: async (ref) =>
          ref.gitdir
            ? [
                { filepath: ".covault/covault.json", kind: "modified" },
                { filepath: "teams/kb/moved.md", kind: "deleted" }, // now lives in the library
                { filepath: "Inbox/gone.md", kind: "deleted" }, // really deleted
              ]
            : [],
        refOids: async () => ({ head: "a", local: "a", remote: "a" }),
        changesInRange: async () => [],
      },
    });
    const index = new FileStatusIndex(d);
    index.refreshAll();
    await settle();
    expect(index.entriesFor("").map((e) => [e.rel, e.status, e.ghost ?? false])).toEqual([
      ["Inbox/x.md", "synced", false],
      ["Inbox/gone.md", "local", true],
    ]);
  });

  it("debounces file events and recomputes only the owning repo", async () => {
    const calls: string[] = [];
    const { d } = deps({
      engine: {
        isRepo: async () => true,
        localChanges: async (ref) => {
          calls.push(ref.dir);
          return [];
        },
        refOids: async () => ({ head: "a", local: "a", remote: "a" }),
        changesInRange: async () => [],
      },
    });
    const index = new FileStatusIndex(d);
    index.fileChanged("teams/kb/a.md");
    index.fileChanged("teams/kb/b.md");
    index.fileChanged("teams/kb/c.md");
    expect(calls).toEqual([]); // nothing yet: debounced
    await settle();
    expect(calls).toEqual(["/v/teams/kb"]);
    index.fileChanged("Inbox/x.md");
    await settle();
    expect(calls).toEqual(["/v/teams/kb", "/v/"]);
  });

  it("waits for a repo's round to end instead of recomputing mid-merge", async () => {
    const calls: string[] = [];
    const { d, syncing } = deps({
      engine: {
        isRepo: async () => true,
        localChanges: async (ref) => {
          calls.push(ref.dir);
          return [];
        },
        refOids: async () => ({ head: "a", local: "a", remote: "a" }),
        changesInRange: async () => [],
      },
    });
    const index = new FileStatusIndex(d);
    syncing.add("teams/kb");
    index.fileChanged("teams/kb/a.md");
    await settle();
    expect(calls).toEqual([]);
    // The round ends: the controller reports the phase change.
    index.syncStatesChanged(new Map([["teams/kb", { phase: "syncing" }]]));
    syncing.delete("teams/kb");
    index.syncStatesChanged(new Map([["teams/kb", { phase: "idle" }]]));
    await settle();
    expect(calls).toEqual(["/v/teams/kb"]);
  });

  it("tells listeners when something changed, and stops after dispose", async () => {
    const { d } = deps();
    const index = new FileStatusIndex(d);
    const heard = vi.fn();
    index.onChange(heard);
    index.refreshAll();
    await settle();
    expect(heard).toHaveBeenCalled();
    index.dispose();
    heard.mockClear();
    index.fileChanged("teams/kb/a.md");
    await settle();
    expect(heard).not.toHaveBeenCalled();
  });
});

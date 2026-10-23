import { describe, expect, it } from "vitest";
import {
  buildTree,
  countStatuses,
  matchesSyncFilter,
  pruneTree,
  repoFileEntries,
  repoRank,
  strongerStatus,
  type FileEntry,
} from "../src/workbench/model";

const lib = "teams/team-kb";

describe("repoFileEntries", () => {
  it("starts every present file as synced and overlays what the engine reports", () => {
    const entries = repoFileEntries({
      repoPath: lib,
      present: ["README.md", "a.md", "b.md", "c.md", "d.md"],
      conflict: ["a.md"],
      local: [{ filepath: "b.md", kind: "modified" }],
      pending: [{ filepath: "c.md", kind: "added" }],
      incoming: [{ filepath: "d.md", kind: "modified", author: "Brooker Fang" }],
    });
    const byRel = Object.fromEntries(entries.map((e) => [e.rel, e]));
    expect(byRel["README.md"]).toMatchObject({ status: "synced", path: `${lib}/README.md` });
    expect(byRel["a.md"]!.status).toBe("conflict");
    expect(byRel["b.md"]).toMatchObject({ status: "local", kind: "modified" });
    expect(byRel["c.md"]).toMatchObject({ status: "pending", kind: "added" });
    expect(byRel["d.md"]).toMatchObject({ status: "incoming", author: "Brooker Fang" });
  });

  it("lets the more important status win when a file has several", () => {
    const [e] = repoFileEntries({
      repoPath: lib,
      present: ["a.md"],
      conflict: [],
      local: [{ filepath: "a.md", kind: "modified" }],
      pending: [],
      incoming: [{ filepath: "a.md", kind: "modified", author: "X" }],
    });
    expect(e!.status).toBe("local"); // edited here beats "new from teammates"
    expect(strongerStatus("incoming", "conflict")).toBe("conflict");
    expect(strongerStatus("pending", "local")).toBe("local");
  });

  it("keeps a deleted file as a ghost row", () => {
    const entries = repoFileEntries({
      repoPath: "",
      present: ["keep.md"],
      conflict: [],
      local: [{ filepath: "gone.md", kind: "deleted" }],
      pending: [],
      incoming: [],
    });
    expect(entries.find((e) => e.rel === "gone.md")).toMatchObject({ status: "local", ghost: true, path: "gone.md" });
  });
});

describe("filters and counts", () => {
  it("counts pending under local — both mean 'not shared yet'", () => {
    expect(countStatuses(["synced", "local", "pending", "incoming", "conflict", "conflict"])).toEqual({
      conflict: 2,
      local: 2,
      incoming: 1,
      synced: 1,
    });
    expect(matchesSyncFilter("pending", "local")).toBe(true);
    expect(matchesSyncFilter("synced", "local")).toBe(false);
    expect(matchesSyncFilter("synced", "all")).toBe(true);
  });
});

describe("buildTree", () => {
  const entries: FileEntry[] = [
    { path: `${lib}/01_doc/b.md`, repoPath: lib, rel: "01_doc/b.md", status: "incoming" },
    { path: `${lib}/01_doc/deep/a.md`, repoPath: lib, rel: "01_doc/deep/a.md", status: "conflict" },
    { path: `${lib}/README.md`, repoPath: lib, rel: "README.md", status: "synced" },
    { path: `${lib}/zz.md`, repoPath: lib, rel: "zz.md", status: "local" },
  ];

  it("nests folders, sorts folders first, and rolls counts up to every folder", () => {
    const tree = buildTree(lib, "team-kb", entries);
    expect(tree.children.map((c) => c.name)).toEqual(["01_doc", "README.md", "zz.md"]);
    const doc = tree.children[0]!;
    expect(doc.children.map((c) => c.name)).toEqual(["deep", "b.md"]);
    expect(doc.counts).toEqual({ conflict: 1, local: 0, incoming: 1, synced: 0 });
    expect(tree.counts).toEqual({ conflict: 1, local: 1, incoming: 1, synced: 1 });
    expect(doc.path).toBe(`${lib}/01_doc`);
  });

  it("prunes to matching files and drops folders left empty", () => {
    const tree = buildTree(lib, "team-kb", entries);
    const only = pruneTree(tree, (e) => e.status === "local");
    expect(only?.children.map((c) => c.name)).toEqual(["zz.md"]);
    expect(only?.counts.local).toBe(1);
    expect(pruneTree(tree, () => false)).toBeNull();
  });

  it("works for the personal knowledge base at the vault root", () => {
    const tree = buildTree("", "My knowledge base", [
      { path: "A0-Inbox/x.md", repoPath: "", rel: "A0-Inbox/x.md", status: "synced" },
    ]);
    expect(tree.children[0]).toMatchObject({ name: "A0-Inbox", path: "A0-Inbox" });
  });
});

describe("repoRank", () => {
  it("puts problems first", () => {
    expect(["idle", "syncing", "error", "conflict"].sort((a, b) => repoRank(a as never) - repoRank(b as never))).toEqual([
      "error",
      "conflict",
      "syncing",
      "idle",
    ]);
  });
});

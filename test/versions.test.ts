import { describe, expect, it } from "vitest";
import type { FileCommit } from "../src/git/GitEngine";
import { assembleVersions, dayLabel } from "../src/workbench/versions";

const commit = (hash: string, message: string, authorName: string, authorEmail: string, at: number, extra: Partial<FileCommit> = {}): FileCommit => ({
  hash,
  parents: [],
  message,
  authorName,
  authorEmail,
  date: new Date(at),
  ...extra,
});

describe("assembleVersions", () => {
  const log = [
    commit("c2", "Add sesame rule", "Cato Wen", "cato@x.com", 2000),
    commit("c1", "Create note", "Jakob", "me@x.com", 1000),
    commit("c0", "", "seed", "s@x.com", 500, { shallowBoundary: true }),
  ];

  it("drops the shallow boundary commit and names the current user You", () => {
    const v = assembleVersions(log, "text", "text", "ME@x.com");
    expect(v.map((x) => [x.key, x.author])).toEqual([
      ["c2", "Cato Wen"],
      ["c1", "You"],
    ]);
  });

  it("puts an unsaved edit on this device first", () => {
    const v = assembleVersions(log, "edited", "text", "me@x.com", 9000);
    expect(v[0]).toMatchObject({ key: "local", local: true, author: "You", at: 9000 });
    expect(v).toHaveLength(3);
  });

  it("treats a file with no commits yet as one local version", () => {
    expect(assembleVersions([], "brand new", null, "me@x.com").map((v) => v.key)).toEqual(["local"]);
    expect(assembleVersions([], null, null, "me@x.com")).toEqual([]);
  });

  it("gives an empty message a label", () => {
    expect(assembleVersions([commit("c", "", "A", "a@x", 1)], null, null, "me").at(0)?.message).toBe("(no message)");
  });
});

describe("dayLabel", () => {
  const now = new Date(2026, 9, 23, 10, 0).getTime();
  it("says Today and Yesterday, then the date", () => {
    expect(dayLabel(new Date(2026, 9, 23, 1).getTime(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 22, 23).getTime(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 14).getTime(), now)).toMatch(/14/);
    expect(dayLabel(new Date(2025, 9, 14).getTime(), now)).toMatch(/2025/);
  });
});

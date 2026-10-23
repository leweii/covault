import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { formatSyncRecord, SyncHistory, type SyncRecord } from "../src/debug/syncHistory";

const record = (files = 0): SyncRecord => ({
  at: new Date(2026, 9, 22, 16, 40, 12).getTime(),
  library: "team-cookbook-kb",
  repoPath: "teams/team-cookbook-kb",
  trigger: "auto",
  status: "ok",
  summary: "saved 2 change(s), shared yours",
  files: Array.from({ length: files }, (_, i) => ({ filepath: `notes/n${i}.md`, kind: "modified" as const })),
  ms: 4200,
});

describe("formatSyncRecord", () => {
  it("puts time, library, trigger, summary and duration on one line, files below", () => {
    const text = formatSyncRecord({ ...record(), files: [{ filepath: "a.md", kind: "added" }] });
    expect(text).toBe(
      "2026-10-22 16:40:12  team-cookbook-kb  auto  saved 2 change(s), shared yours  (4.2s)\n    ↑ A a.md",
    );
  });

  it("caps the file list", () => {
    const lines = formatSyncRecord(record(25)).split("\n");
    expect(lines).toHaveLength(1 + 20 + 1);
    expect(lines.at(-1)).toBe("    ↑ … and 5 more");
  });

  it("lists teammates' changes under ↓, crediting each file when the engine knows who", () => {
    const text = formatSyncRecord({
      ...record(),
      incoming: {
        files: [
          { filepath: "b.md", kind: "modified", author: "Brooker Fang" },
          { filepath: "c.md", kind: "deleted" },
        ],
        authors: ["Brooker Fang"],
      },
    });
    expect(text.split("\n").slice(1)).toEqual(["    ↓ M b.md   (Brooker Fang)", "    ↓ D c.md"]);
  });

  it("falls back to the round's author list for records without per-file credit", () => {
    const text = formatSyncRecord({
      ...record(),
      incoming: { files: [{ filepath: "b.md", kind: "modified" }, { filepath: "c.md", kind: "deleted" }], authors: ["Brooker Fang"] },
    });
    expect(text.split("\n").slice(1)).toEqual(["    ↓ M b.md   (Brooker Fang)", "    ↓ D c.md"]);
  });

  it("tags failed rounds and rounds that stopped on a conflict", () => {
    expect(formatSyncRecord({ ...record(), status: "error", summary: "failed — no network", error: "no network" })).toContain(
      "  auto  FAILED  failed — no network  (4.2s)",
    );
    expect(formatSyncRecord({ ...record(), status: "conflict", summary: "1 note(s) need your input" })).toContain(
      "  auto  NEEDS INPUT  1 note(s) need your input  (4.2s)",
    );
  });
});

describe("SyncHistory", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "covault-hist-"));

  it("appends rounds to the text file and reads back the tail", () => {
    const dir = tmp();
    const history = new SyncHistory({ fs, logDir: () => dir });
    history.append(record());
    history.append({ ...record(), library: "team-oms-kb" });
    const tail = history.tail();
    expect(tail.split("\n")).toHaveLength(2);
    expect(tail).toContain("team-oms-kb");
    expect(history.tail(1)).toContain("team-oms-kb");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the same rounds as JSON, newest first, across restarts", () => {
    const dir = tmp();
    const history = new SyncHistory({ fs, logDir: () => dir });
    history.append({ ...record(), at: 1, summary: "one" });
    history.append({ ...record(), at: 2, summary: "two", status: "error", error: "x" });
    expect(history.records().map((r) => r.summary)).toEqual(["two", "one"]);
    expect(history.records(1)).toHaveLength(1);

    const reopened = new SyncHistory({ fs, logDir: () => dir });
    expect(reopened.records().map((r) => [r.summary, r.status])).toEqual([
      ["two", "error"],
      ["one", "ok"],
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the newest 500 JSON records", () => {
    const dir = tmp();
    const history = new SyncHistory({ fs, logDir: () => dir });
    for (let i = 0; i < 505; i++) history.append({ ...record(), at: i, summary: `r${i}` });
    const again = new SyncHistory({ fs, logDir: () => dir }).records();
    expect(again).toHaveLength(500);
    expect(again[0]!.summary).toBe("r504");
    expect(again.at(-1)!.summary).toBe("r5");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips a torn JSON line instead of losing the file", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "sync-history.jsonl"), `${JSON.stringify(record())}\n{"at": 5, "libr\n`);
    expect(new SyncHistory({ fs, logDir: () => dir }).records()).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is empty, not an error, before anything synced", () => {
    const history = new SyncHistory({ fs, logDir: () => "/nonexistent/covault" });
    expect(history.tail()).toBe("");
    expect(history.records()).toEqual([]);
  });
});

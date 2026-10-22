import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { formatSyncRecord, SyncHistory } from "../src/debug/syncHistory";

const record = (files = 0) => ({
  at: new Date(2026, 9, 22, 16, 40, 12).getTime(),
  library: "team-cookbook-kb",
  trigger: "auto" as const,
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

  it("lists teammates' changes under ↓ with who made them", () => {
    const text = formatSyncRecord({
      ...record(),
      incoming: { files: [{ filepath: "b.md", kind: "modified" }, { filepath: "c.md", kind: "deleted" }], authors: ["Brooker Fang"] },
    });
    expect(text.split("\n").slice(1)).toEqual(["    ↓ M b.md   (Brooker Fang)", "    ↓ D c.md"]);
  });
});

describe("SyncHistory", () => {
  it("appends rounds and reads back the tail", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covault-hist-"));
    const history = new SyncHistory({ fs, logDir: () => dir });
    history.append(record());
    history.append({ ...record(), library: "team-oms-kb" });
    const tail = history.tail();
    expect(tail.split("\n")).toHaveLength(2);
    expect(tail).toContain("team-oms-kb");
    expect(history.tail(1)).toContain("team-oms-kb");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is empty, not an error, before anything synced", () => {
    expect(new SyncHistory({ fs, logDir: () => "/nonexistent/covault" }).tail()).toBe("");
  });
});

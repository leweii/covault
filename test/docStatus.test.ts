import { describe, expect, it } from "vitest";
import { DEFAULT_DOC_STATUSES } from "../src/settings";
import { readDocStatus, sanitizeDocStatuses, statusIdFor, writeDocStatus } from "../src/workbench/docStatus";

describe("readDocStatus", () => {
  it("matches the frontmatter label to a definition, case-insensitively", () => {
    const s = readDocStatus({ status: "in Review", status_by: "Cato Wen", status_at: "2026-10-22T10:00:00Z" }, DEFAULT_DOC_STATUSES);
    expect(s?.def?.id).toBe("review");
    expect(s?.by).toBe("Cato Wen");
    expect(s?.at).toBe(Date.parse("2026-10-22T10:00:00Z"));
  });

  it("keeps an unknown label as raw text with no definition", () => {
    expect(readDocStatus({ status: "Archived" }, DEFAULT_DOC_STATUSES)).toEqual({ def: null, raw: "Archived" });
  });

  it("is null without a status, or with a non-string one", () => {
    expect(readDocStatus({}, DEFAULT_DOC_STATUSES)).toBeNull();
    expect(readDocStatus({ status: 3 }, DEFAULT_DOC_STATUSES)).toBeNull();
    expect(readDocStatus(undefined, DEFAULT_DOC_STATUSES)).toBeNull();
  });
});

describe("writeDocStatus", () => {
  it("writes the three keys, and clearing removes all of them", () => {
    const fm: Record<string, unknown> = { title: "x" };
    writeDocStatus(fm, DEFAULT_DOC_STATUSES[2]!, "You", new Date("2026-10-23T01:02:03Z"));
    expect(fm).toEqual({ title: "x", status: "Approved", status_by: "You", status_at: "2026-10-23T01:02:03.000Z" });
    writeDocStatus(fm, null, "You");
    expect(fm).toEqual({ title: "x" });
  });
});

describe("sanitizeDocStatuses", () => {
  it("accepts well-formed entries and repairs what it can", () => {
    expect(
      sanitizeDocStatuses([
        { id: "draft", label: "Draft", color: "#ABCDEF" },
        { label: "Needs update", color: "red" }, // no id, bad colour
        { id: "draft", label: "Dup id" },
        { label: "   " },
        "junk",
      ]),
    ).toEqual([
      { id: "draft", label: "Draft", color: "#abcdef" },
      { id: "needs-update", label: "Needs update", color: DEFAULT_DOC_STATUSES[1]!.color },
    ]);
  });

  it("is null for anything unusable, so callers keep their defaults", () => {
    expect(sanitizeDocStatuses(undefined)).toBeNull();
    expect(sanitizeDocStatuses("nope")).toBeNull();
    expect(sanitizeDocStatuses([])).toBeNull();
    expect(sanitizeDocStatuses([{ color: "#000000" }])).toBeNull();
  });
});

describe("statusIdFor", () => {
  it("slugs the label and keeps ids unique", () => {
    expect(statusIdFor("In Review!", [])).toBe("in-review");
    expect(statusIdFor("Draft", DEFAULT_DOC_STATUSES)).toBe("draft-2");
    expect(statusIdFor("草稿", [])).toBe("status");
  });
});

import { describe, expect, it } from "vitest";
import { applyResolutions, extractHunks, getContextLines, isFullyResolved, parseConflict } from "../src/sync/ConflictParser";
import { buildPrompt, parseAIResponse } from "../src/llm/resolver";

const CONFLICTED = [
  "# Title",
  "",
  "intro line",
  "<<<<<<< HEAD",
  "my version",
  "=======",
  "their version",
  ">>>>>>> incoming",
  "outro line",
].join("\n");

describe("ConflictParser", () => {
  it("splits content into common and conflict segments", () => {
    const segments = parseConflict(CONFLICTED);
    const hunks = extractHunks(segments);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.local).toEqual(["my version"]);
    expect(hunks[0]?.remote).toEqual(["their version"]);
    expect(segments.filter((s) => s.kind === "common")).toHaveLength(2);
  });

  it("applies resolutions and reports completeness", () => {
    const segments = parseConflict(CONFLICTED);
    const [hunk] = extractHunks(segments);
    const resolutions = new Map();
    expect(isFullyResolved(segments, resolutions)).toBe(false);
    resolutions.set(hunk!.id, { kind: "edit", text: "merged version" });
    expect(isFullyResolved(segments, resolutions)).toBe(true);
    const out = applyResolutions(segments, resolutions);
    expect(out).toContain("merged version");
    expect(out).not.toContain("<<<<<<<");
    expect(out.startsWith("# Title")).toBe(true);
  });

  it("keeps markers for skipped hunks", () => {
    const segments = parseConflict(CONFLICTED);
    const out = applyResolutions(segments, new Map());
    expect(out).toContain("<<<<<<< HEAD");
  });

  it("extracts surrounding context", () => {
    const segments = parseConflict(CONFLICTED);
    const [hunk] = extractHunks(segments);
    const ctx = getContextLines(segments, hunk!.id, 2);
    expect(ctx.before).toEqual(["", "intro line"]);
    expect(ctx.after).toEqual(["outro line"]);
  });
});

describe("resolver prompt/response", () => {
  it("builds a prompt with both sides and context", () => {
    const prompt = buildPrompt({
      filePath: "notes/a.md",
      hunk: { local: ["mine"], remote: ["theirs"] },
      context: { before: ["ctx1"], after: ["ctx2"] },
    });
    expect(prompt).toContain("File: notes/a.md");
    expect(prompt).toContain("mine");
    expect(prompt).toContain("theirs");
    expect(prompt).toContain("ctx1");
  });

  it("parses a clean JSON response", () => {
    const r = parseAIResponse('{"merged":["a","b"],"reasoning":["r"],"confidence":4,"picks":[1]}');
    expect(r.merged).toEqual(["a", "b"]);
    expect(r.confidence).toBe(4);
    expect(r.picks).toEqual([1]);
  });

  it("survives fenced and chatty responses, clamps bad fields", () => {
    const r = parseAIResponse('Sure!\n```json\n{"merged":"x\\ny","confidence":99,"picks":[0,7]}\n```');
    expect(r.merged).toEqual(["x", "y"]);
    expect(r.confidence).toBe(5);
    expect(r.picks).toEqual([0]);
  });

  it("throws on non-JSON", () => {
    expect(() => parseAIResponse("I cannot help with that")).toThrow();
  });
});

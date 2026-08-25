import { describe, expect, it } from "vitest";
import { buildDescribePrompt, sanitizeDescription } from "../src/llm/describe";
import type { LibraryFacts } from "../src/covault/skill";

const facts: LibraryFacts = {
  repo: { path: "teams/ccp-kb", url: "https://github.com/ct-kb/ccp-kb.git", branch: "main" },
  name: "ccp-kb",
  noteCount: 71,
  topEntries: ["02_domain/ (49 notes)", "README.md"],
  readmeExcerpt: "CCP — the Customer Care Portal. The back-office tool support agents work in.",
  readmePath: "teams/ccp-kb/README.md",
};

describe("buildDescribePrompt", () => {
  it("carries name, structure, and README into the prompt", () => {
    const p = buildDescribePrompt(facts);
    expect(p).toContain("Library name: ccp-kb");
    expect(p).toContain("Structure: 02_domain/ (49 notes), README.md");
    expect(p).toContain("Customer Care Portal");
  });

  it("omits sections that have no facts", () => {
    const p = buildDescribePrompt({ ...facts, topEntries: [], readmeExcerpt: null });
    expect(p).not.toContain("Structure:");
    expect(p).not.toContain("README begins:");
  });
});

describe("sanitizeDescription", () => {
  it("keeps one clean line whatever the model wraps it in", () => {
    expect(sanitizeDescription('  "Customer Care Portal — Zendesk bridge."  ')).toBe(
      "Customer Care Portal — Zendesk bridge",
    );
    expect(sanitizeDescription("First line\nSecond line")).toBe("First line");
    expect(sanitizeDescription("")).toBe("");
    expect(sanitizeDescription("x".repeat(300))).toHaveLength(201); // 200 + ellipsis
  });
});

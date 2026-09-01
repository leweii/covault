import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyManagedBlock,
  buildAgentBlock,
  removeAdapters,
  removeManagedBlock,
  writeAdapters,
} from "../src/covault/adapters";
import type { ManifestRepo } from "../src/covault/manifest";

let vault: string;

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "covault-adapters-"));
});
afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
});

function lib(p: string, description?: string): ManifestRepo {
  const repo: ManifestRepo = { path: p, url: `https://github.com/ct-kb/${p.split("/").pop()}.git`, branch: "main" };
  return description ? { ...repo, description } : repo;
}

describe("buildAgentBlock", () => {
  it("lists every library with its path, pointing at the generated skill", () => {
    const block = buildAgentBlock([lib("teams/ccp-kb", "Customer Care Portal — Zendesk bridge")]);
    expect(block).toContain("- ccp-kb — `teams/ccp-kb/` — Customer Care Portal — Zendesk bridge");
    expect(block).toContain(".claude/skills/team-knowledge/SKILL.md");
    expect(block).toContain(".pi/skills/team-knowledge/SKILL.md");
    expect(block).toContain(".codex/skills/team-knowledge/SKILL.md");
    expect(block.startsWith("<!-- >>> covault managed")).toBe(true);
  });

  it("is deterministic regardless of input order (sync-safety invariant)", () => {
    expect(buildAgentBlock([lib("a-kb"), lib("b-kb")])).toBe(buildAgentBlock([lib("b-kb"), lib("a-kb")]));
  });
});

describe("applyManagedBlock / removeManagedBlock", () => {
  it("creates, appends after user content, replaces in place, stays idempotent", () => {
    const file = path.join(vault, "AGENTS.md");

    // create
    expect(applyManagedBlock(file, buildAgentBlock([lib("a-kb")]))).toBe(true);
    // idempotent
    expect(applyManagedBlock(file, buildAgentBlock([lib("a-kb")]))).toBe(false);

    // user content survives an update
    fs.writeFileSync(file, `# My own rules\nBe terse.\n\n${fs.readFileSync(file, "utf8")}`);
    expect(applyManagedBlock(file, buildAgentBlock([lib("a-kb"), lib("b-kb")]))).toBe(true);
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("Be terse.");
    expect(content).toContain("- b-kb");
    expect(content.match(/covault managed — do not edit/g)).toHaveLength(1);

    // removal keeps the user's part, drops ours
    removeManagedBlock(file);
    const rest = fs.readFileSync(file, "utf8");
    expect(rest).toContain("Be terse.");
    expect(rest).not.toContain("covault managed");
  });

  it("appends to a user file that has no block yet", () => {
    const file = path.join(vault, "CLAUDE.md");
    fs.writeFileSync(file, "# Mine\n");
    applyManagedBlock(file, buildAgentBlock([lib("a-kb")]));
    const content = fs.readFileSync(file, "utf8");
    expect(content.startsWith("# Mine")).toBe(true);
    expect(content).toContain("- a-kb");
  });

  it("deletes the file entirely when it held nothing but our block", () => {
    const file = path.join(vault, "AGENTS.md");
    applyManagedBlock(file, buildAgentBlock([lib("a-kb")]));
    removeManagedBlock(file);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("writeAdapters / removeAdapters", () => {
  it("maintains both targets and reports change correctly", () => {
    expect(writeAdapters(vault, [lib("a-kb")])).toBe(true);
    expect(fs.existsSync(path.join(vault, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(vault, "CLAUDE.md"))).toBe(true);
    expect(writeAdapters(vault, [lib("a-kb")])).toBe(false); // unchanged

    removeAdapters(vault);
    expect(fs.existsSync(path.join(vault, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(vault, "CLAUDE.md"))).toBe(false);
  });

  it("treats an empty library list as removal — no noise in empty vaults", () => {
    writeAdapters(vault, [lib("a-kb")]);
    expect(writeAdapters(vault, [])).toBe(false);
    expect(fs.existsSync(path.join(vault, "AGENTS.md"))).toBe(false);
  });
});

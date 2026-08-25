import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildKnowledgeSkill, writeKnowledgeSkill, SKILL_RELPATH } from "../src/covault/skill";
import type { ManifestRepo } from "../src/covault/manifest";

let vault: string;

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "covault-skill-"));
});
afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
});

function lib(p: string): ManifestRepo {
  return { path: p, url: `https://github.com/ct-kb/${p.split("/").pop()}.git`, branch: "main" };
}

describe("buildKnowledgeSkill", () => {
  it("routes each library with source, size, entry point, and README excerpt", () => {
    const dir = path.join(vault, "teams", "platform-kb");
    fs.mkdirSync(path.join(dir, "runbooks"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true }); // must not be listed or counted
    fs.writeFileSync(path.join(dir, ".git", "junk.md"), "x");
    fs.writeFileSync(path.join(dir, "README.md"), "---\ntitle: x\n---\n# Platform KB\n\nDeploys, CI and infrastructure.\n");
    fs.writeFileSync(path.join(dir, "faq.md"), "# FAQ\n");
    fs.writeFileSync(path.join(dir, "runbooks", "oncall.md"), "# Oncall\n");

    const doc = buildKnowledgeSkill(vault, [lib("teams/platform-kb")]);

    expect(doc).toContain("name: team-knowledge");
    expect(doc).toContain("platform-kb"); // in the frontmatter description
    expect(doc).toContain("## platform-kb — `teams/platform-kb/`");
    expect(doc).toContain("- Source: https://github.com/ct-kb/platform-kb (main)");
    expect(doc).toContain("- Size: 3 notes");
    expect(doc).toContain("- Start here: `teams/platform-kb/README.md`");
    expect(doc).toContain("runbooks/ (1 note)");
    expect(doc).toContain("Deploys, CI and infrastructure.");
    expect(doc).not.toContain("junk.md");
  });

  it("is deterministic and library-order-independent", () => {
    for (const p of ["b-kb", "a-kb"]) fs.mkdirSync(path.join(vault, p), { recursive: true });
    const one = buildKnowledgeSkill(vault, [lib("a-kb"), lib("b-kb")]);
    const two = buildKnowledgeSkill(vault, [lib("b-kb"), lib("a-kb")]);
    expect(one).toBe(two);
    expect(one.indexOf("## a-kb")).toBeLessThan(one.indexOf("## b-kb"));
  });

  it("still lists a library whose folder hasn't been cloned yet", () => {
    const doc = buildKnowledgeSkill(vault, [lib("not-yet-cloned")]);
    expect(doc).toContain("## not-yet-cloned");
    expect(doc).toContain("- Size: 0 notes");
  });

  it("says so when no libraries are installed", () => {
    expect(buildKnowledgeSkill(vault, [])).toContain("No libraries installed yet");
  });
});

describe("writeKnowledgeSkill", () => {
  it("writes only when the content changed", () => {
    fs.mkdirSync(path.join(vault, "a-kb"), { recursive: true });
    expect(writeKnowledgeSkill(vault, [lib("a-kb")])).toBe(true);
    const file = path.join(vault, SKILL_RELPATH);
    expect(fs.existsSync(file)).toBe(true);
    expect(writeKnowledgeSkill(vault, [lib("a-kb")])).toBe(false); // unchanged

    fs.writeFileSync(path.join(vault, "a-kb", "new.md"), "# hi\n");
    expect(writeKnowledgeSkill(vault, [lib("a-kb")])).toBe(true); // note count changed
  });
});

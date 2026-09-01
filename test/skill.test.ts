import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildKnowledgeSkill,
  migrateLegacySkill,
  removeKnowledgeSkill,
  writeKnowledgeSkill,
  SKILL_TARGETS,
} from "../src/covault/skill";
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

  it("keeps the description inside the Agent Skills cap, however many libraries", () => {
    const many = Array.from({ length: 40 }, (_, i) => lib(`a-very-long-library-name-number-${i}-kb`));
    const doc = buildKnowledgeSkill(vault, many);
    const description = doc.split("\n").find((l) => l.startsWith("description: "))!;
    expect(description.length).toBeLessThanOrEqual("description: ".length + 1024);
    expect(description).toContain("…"); // trimmed, and says so
    // Every library still appears in the body, which has no cap.
    expect(doc).toContain("## a-very-long-library-name-number-39-kb");
  });

  it("says so when no libraries are installed", () => {
    expect(buildKnowledgeSkill(vault, [])).toContain("No libraries installed yet");
  });
});

describe("writeKnowledgeSkill", () => {
  it("writes only when the content changed", () => {
    fs.mkdirSync(path.join(vault, "a-kb"), { recursive: true });
    expect(writeKnowledgeSkill(vault, [lib("a-kb")])).toBe(true);
    expect(writeKnowledgeSkill(vault, [lib("a-kb")])).toBe(false); // unchanged

    fs.writeFileSync(path.join(vault, "a-kb", "new.md"), "# hi\n");
    expect(writeKnowledgeSkill(vault, [lib("a-kb")])).toBe(true); // note count changed
  });

  it("lands in the standard skill folders, same bytes in each", () => {
    fs.mkdirSync(path.join(vault, "a-kb"), { recursive: true });
    writeKnowledgeSkill(vault, [lib("a-kb")]);
    expect(SKILL_TARGETS).toEqual([
      ".claude/skills/team-knowledge/SKILL.md",
      ".pi/skills/team-knowledge/SKILL.md",
      ".codex/skills/team-knowledge/SKILL.md",
    ]);
    const written = SKILL_TARGETS.map((t) => fs.readFileSync(path.join(vault, t), "utf8"));
    expect(written[0]).toContain("name: team-knowledge");
    expect(new Set(written).size).toBe(1);
  });

  it("writes nothing when there are no libraries, and cleans up after itself", () => {
    fs.mkdirSync(path.join(vault, "a-kb"), { recursive: true });
    writeKnowledgeSkill(vault, [lib("a-kb")]);
    expect(writeKnowledgeSkill(vault, [])).toBe(false);
    expect(fs.existsSync(path.join(vault, ".claude"))).toBe(false); // emptied → tidied
    expect(fs.existsSync(path.join(vault, ".pi"))).toBe(false);
    expect(fs.existsSync(path.join(vault, ".codex"))).toBe(false);
  });

  it("leaves the user's own skills alone when ours goes", () => {
    fs.mkdirSync(path.join(vault, ".claude/skills/my-own"), { recursive: true });
    fs.writeFileSync(path.join(vault, ".claude/skills/my-own/SKILL.md"), "---\nname: my-own\n---\n");
    fs.mkdirSync(path.join(vault, "a-kb"), { recursive: true });
    writeKnowledgeSkill(vault, [lib("a-kb")]);
    removeKnowledgeSkill(vault);
    expect(fs.existsSync(path.join(vault, ".claude/skills/team-knowledge"))).toBe(false);
    expect(fs.existsSync(path.join(vault, ".claude/skills/my-own/SKILL.md"))).toBe(true);
  });
});

describe("migrateLegacySkill", () => {
  it("drops the old covault-private copy of the map", () => {
    fs.mkdirSync(path.join(vault, ".covault/skills"), { recursive: true });
    fs.writeFileSync(path.join(vault, ".covault/skills/team-knowledge.md"), "# old\n");
    migrateLegacySkill(vault);
    expect(fs.existsSync(path.join(vault, ".covault/skills"))).toBe(false);
    migrateLegacySkill(vault); // idempotent — nothing there to remove
  });
});

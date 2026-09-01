import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManifestStore } from "../src/covault/manifest";
import { ensureIgnored } from "../src/covault/gitignore";

let vault: string;

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "covault-manifest-"));
});
afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
});

describe("ManifestStore", () => {
  it("returns an empty manifest when the file is missing", () => {
    expect(new ManifestStore(vault).load()).toEqual({ version: 1, repos: [], include: [], scope: "marked" });
  });

  it("defaults to opt-in scope and round-trips the whole-vault switch", () => {
    const store = new ManifestStore(vault);
    store.addInclude("notes"); // a manifest written before scopes existed
    const raw = JSON.parse(fs.readFileSync(path.join(vault, ".covault", "covault.json"), "utf8")) as {
      scope?: string;
    };
    delete raw.scope;
    fs.writeFileSync(path.join(vault, ".covault", "covault.json"), JSON.stringify(raw));
    expect(store.load().scope).toBe("marked");

    store.setScope("vault");
    expect(new ManifestStore(vault).load().scope).toBe("vault");
    // The marks survive the switch, so going back restores the old setup.
    expect(store.load().include).toEqual(["notes"]);
    store.setScope("marked");
    expect(new ManifestStore(vault).load().scope).toBe("marked");
  });

  it("marks and unmarks include paths, collapsing children into parents", () => {
    const store = new ManifestStore(vault);
    store.addInclude("notes/projects/alpha.md");
    store.addInclude("notes/projects"); // parent absorbs the child entry
    expect(store.load().include).toEqual(["notes/projects"]);
    store.removeInclude("notes/projects");
    expect(store.load().include).toEqual([]);
  });

  it("stores and remaps library descriptions", () => {
    const store = new ManifestStore(vault);
    store.add({ path: "teams/ccp-kb", url: "https://github.com/o/ccp.git", branch: "main" });
    store.setDescription("teams/ccp-kb", "Customer Care Portal — Zendesk bridge");
    expect(new ManifestStore(vault).load().repos[0]?.description).toBe("Customer Care Portal — Zendesk bridge");
    // The description follows the folder when it moves.
    store.rename("teams", "depts");
    expect(new ManifestStore(vault).load().repos[0]?.description).toBe("Customer Care Portal — Zendesk bridge");
    // Unknown path is a no-op.
    store.setDescription("nope", "x");
    expect(new ManifestStore(vault).load().repos).toHaveLength(1);
  });

  it("adds, persists, sorts, and dedupes by path", () => {
    const store = new ManifestStore(vault);
    store.add({ path: "teams/z-kb", url: "https://github.com/o/z.git", branch: "main" });
    store.add({ path: "teams/a-kb", url: "https://github.com/o/a.git", branch: "main" });
    store.add({ path: "teams/a-kb", url: "https://github.com/o/other.git", branch: "dev" }); // dup path ignored

    const loaded = new ManifestStore(vault).load();
    expect(loaded.repos.map((r) => r.path)).toEqual(["teams/a-kb", "teams/z-kb"]);
    expect(loaded.repos[0]?.url).toBe("https://github.com/o/a.git");
  });

  it("removes by path", () => {
    const store = new ManifestStore(vault);
    store.add({ path: "teams/a", url: "u", branch: "main" });
    store.remove("teams/a");
    expect(store.load().repos).toEqual([]);
  });

  it("remaps repos and include marks on rename/move", () => {
    const store = new ManifestStore(vault);
    store.add({ path: "teams/a-kb", url: "u", branch: "main" });
    store.addInclude("notes/plan.md");
    store.addInclude("projects");

    // File rename follows the mark.
    expect(store.rename("notes/plan.md", "notes/roadmap.md")).toBe(true);
    expect(store.load().include).toContain("notes/roadmap.md");
    // Parent folder move remaps children and library paths alike.
    expect(store.rename("teams", "shared-teams")).toBe(true);
    expect(store.load().repos[0]?.path).toBe("shared-teams/a-kb");
    // Unrelated rename is a no-op.
    expect(store.rename("something/else.md", "x.md")).toBe(false);
  });

  it("survives a corrupt file", () => {
    fs.mkdirSync(path.join(vault, ".covault"));
    fs.writeFileSync(path.join(vault, ".covault", "covault.json"), "{not json");
    expect(new ManifestStore(vault).load()).toEqual({ version: 1, repos: [], include: [], scope: "marked" });
  });

});

describe("ensureIgnored", () => {
  it("creates .gitignore with a managed block", () => {
    ensureIgnored(vault, ["teams/a-kb", "teams/b-kb"]);
    const content = fs.readFileSync(path.join(vault, ".gitignore"), "utf8");
    expect(content).toContain("/teams/a-kb/");
    expect(content).toContain("/teams/b-kb/");
    // The generated skill lives in the standard skill folders now, and
    // only ours is ignored there.
    expect(content).toContain("/.claude/skills/team-knowledge/");
    expect(content).toContain("/.pi/skills/team-knowledge/");
    expect(content).toContain("/.codex/skills/team-knowledge/");
    // Deleted library folders land in the vault trash; a vault-root repo
    // another tool syncs must not pick their contents back up.
    expect(content).toContain("/.trash/");
  });

  it("preserves user content and updates only its own block, idempotently", () => {
    fs.writeFileSync(path.join(vault, ".gitignore"), "node_modules/\n");
    ensureIgnored(vault, ["teams/a"]);
    ensureIgnored(vault, ["teams/a", "teams/b"]);
    ensureIgnored(vault, ["teams/a", "teams/b"]); // no-op
    const content = fs.readFileSync(path.join(vault, ".gitignore"), "utf8");
    expect(content).toContain("node_modules/");
    expect(content.match(/covault managed — do not edit/g)).toHaveLength(1);
    expect(content).toContain("/teams/a/");
    expect(content).toContain("/teams/b/");
  });

  it("drops paths removed from the manifest", () => {
    ensureIgnored(vault, ["teams/a", "teams/b"]);
    ensureIgnored(vault, ["teams/a"]);
    const content = fs.readFileSync(path.join(vault, ".gitignore"), "utf8");
    expect(content).not.toContain("/teams/b/");
  });
});

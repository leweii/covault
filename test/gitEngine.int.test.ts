/**
 * Integration test: the full silent-sync flow (clone → edit → push → pull →
 * diverge → merge → conflict) against a real git smart-HTTP remote served
 * by `git http-backend` (see gitHttpServer.ts). Uses isomorphic-git's node
 * http client where the plugin uses the requestUrl one.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// eslint-disable-next-line import/no-internal-modules
import nodeHttp from "isomorphic-git/http/node";
import { GitEngine, type RepoRef } from "../src/git/GitEngine";
import { PatTokenProvider } from "../src/auth/TokenProvider";
import { startGitServer, type GitServer } from "./gitHttpServer";

let root: string;
let server: GitServer;
let engineA: GitEngine;
let engineB: GitEngine;
let refA: RepoRef;
let refB: RepoRef;

const msg = (changes: { filepath: string }[]) => `Update ${changes.length} file(s)`;

function makeEngine(name: string): GitEngine {
  return new GitEngine({
    fs,
    http: nodeHttp,
    tokens: new PatTokenProvider(() => ""),
    author: () => ({ name, email: `${name}@test.local` }),
    configDir: () => ".obsidian",
  });
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "covault-int-"));

  // Bare remote with one seed commit, push enabled.
  const bare = path.join(root, "team-kb.git");
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bare });
  const seed = path.join(root, "seed");
  execFileSync("git", ["clone", bare, seed]);
  fs.writeFileSync(path.join(seed, "README.md"), "# Team KB\n");
  execFileSync("git", ["add", "."], { cwd: seed });
  execFileSync("git", ["-c", "user.name=seed", "-c", "user.email=seed@test.local", "commit", "-m", "seed"], {
    cwd: seed,
  });
  execFileSync("git", ["push", "origin", "main"], { cwd: seed });

  server = await startGitServer(root);
  const url = `${server.url}/team-kb.git`;
  refA = { dir: path.join(root, "clientA"), url, branch: "main" };
  refB = { dir: path.join(root, "clientB"), url, branch: "main" };
  engineA = makeEngine("alice");
  engineB = makeEngine("bob");
});

afterAll(async () => {
  await server?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GitEngine against a real smart-HTTP remote", () => {
  it("clones the library", async () => {
    await engineA.clone(refA);
    expect(fs.readFileSync(path.join(refA.dir, "README.md"), "utf8")).toContain("Team KB");
    expect(await engineA.isRepo(refA)).toBe(true);
  });

  it("commits and pushes local edits (consumer stays silent)", async () => {
    fs.writeFileSync(path.join(refA.dir, "glossary.md"), "# Glossary\n\nSP: sprint\n");
    const result = await engineA.syncToRemote(refA, { commitMessage: msg });
    expect(result.committed.map((c) => c.filepath)).toEqual(["glossary.md"]);
    expect(result.pushed).toBe(true);
    expect(result.conflictFilepaths).toEqual([]);
  });

  it("second client pulls those edits via fast-forward", async () => {
    await engineB.clone(refB);
    expect(fs.existsSync(path.join(refB.dir, "glossary.md"))).toBe(true);

    fs.writeFileSync(path.join(refA.dir, "onboarding.md"), "# Onboarding\n");
    await engineA.syncToRemote(refA, { commitMessage: msg });

    const result = await engineB.syncToRemote(refB, { commitMessage: msg });
    expect(result.pulled).toBe(true);
    expect(result.pushed).toBe(false);
    expect(fs.existsSync(path.join(refB.dir, "onboarding.md"))).toBe(true);
  });

  it("reports up-to-date when nothing changed anywhere", async () => {
    const result = await engineB.syncToRemote(refB, { commitMessage: msg });
    expect(result).toEqual({ committed: [], pulled: false, pushed: false, conflictFilepaths: [] });
  });

  it("merges diverged non-overlapping edits and pushes the merge", async () => {
    fs.writeFileSync(path.join(refA.dir, "from-alice.md"), "alice\n");
    fs.writeFileSync(path.join(refB.dir, "from-bob.md"), "bob\n");
    const pushA = await engineA.syncToRemote(refA, { commitMessage: msg });
    expect(pushA.pushed).toBe(true);

    // B is now diverged: local commit + remote commit.
    const result = await engineB.syncToRemote(refB, { commitMessage: msg });
    expect(result.conflictFilepaths).toEqual([]);
    expect(result.pulled).toBe(true);
    expect(result.pushed).toBe(true);
    expect(fs.existsSync(path.join(refB.dir, "from-alice.md"))).toBe(true);

    // A picks up the merge.
    const follow = await engineA.syncToRemote(refA, { commitMessage: msg });
    expect(follow.pulled).toBe(true);
    expect(fs.existsSync(path.join(refA.dir, "from-bob.md"))).toBe(true);
  });

  it("detects deletions", async () => {
    fs.unlinkSync(path.join(refA.dir, "onboarding.md"));
    const changes = await engineA.localChanges(refA);
    expect(changes).toEqual([{ filepath: "onboarding.md", kind: "deleted" }]);
    const result = await engineA.syncToRemote(refA, { commitMessage: msg });
    expect(result.pushed).toBe(true);
  });

  it("surfaces same-line conflicts with markers left in the tree", async () => {
    // Both edit the same line of glossary.md.
    await engineB.syncToRemote(refB, { commitMessage: msg }); // level the field
    fs.writeFileSync(path.join(refA.dir, "glossary.md"), "# Glossary\n\nSP: story points\n");
    fs.writeFileSync(path.join(refB.dir, "glossary.md"), "# Glossary\n\nSP: sprint planning\n");
    await engineA.syncToRemote(refA, { commitMessage: msg });

    const result = await engineB.syncToRemote(refB, { commitMessage: msg });
    expect(result.conflictFilepaths).toEqual(["glossary.md"]);
    expect(result.pushed).toBe(false);
    const content = fs.readFileSync(path.join(refB.dir, "glossary.md"), "utf8");
    expect(content).toContain("<<<<<<<");
    expect(content).toContain(">>>>>>>");
  });

  it("shares an existing folder into a fresh empty remote (initAndPush)", async () => {
    // New empty bare remote, like createOrgRepo just made it.
    const bare = path.join(root, "shared-kb.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bare });

    // A plain vault folder with notes, not yet a repo.
    const folder = path.join(root, "clientA-share");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "howto.md"), "# How to\n");
    const shareRef: RepoRef = { dir: folder, url: `${server.url}/shared-kb.git`, branch: "main" };

    await engineA.initAndPush(shareRef, "Share folder");
    expect(await engineA.isRepo(shareRef)).toBe(true);

    // Someone else can clone it and sees the content.
    const other: RepoRef = { dir: path.join(root, "clientB-share"), url: shareRef.url, branch: "main" };
    await engineB.clone(other);
    expect(fs.readFileSync(path.join(other.dir, "howto.md"), "utf8")).toContain("How to");
  });

  it("adopts a remote with unrelated history (personal KB setup)", async () => {
    // Remote already has content (e.g. an existing personal-kb repo)…
    const bare = path.join(root, "personal-kb.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bare });
    const seed = path.join(root, "kb-seed");
    execFileSync("git", ["clone", bare, seed]);
    fs.writeFileSync(path.join(seed, "old-notes.md"), "# Old\n");
    execFileSync("git", ["add", "."], { cwd: seed });
    execFileSync("git", ["-c", "user.name=s", "-c", "user.email=s@t", "commit", "-m", "seed"], { cwd: seed });
    execFileSync("git", ["push", "origin", "main"], { cwd: seed });

    // …and the local vault root has its own unrelated content.
    const vaultRoot = path.join(root, "vault-adopt");
    fs.mkdirSync(path.join(vaultRoot, "teams", "some-lib"), { recursive: true });
    fs.writeFileSync(path.join(vaultRoot, "my-note.md"), "# Mine\n");
    fs.writeFileSync(path.join(vaultRoot, "teams", "some-lib", "lib-note.md"), "# Lib\n");
    const ref: RepoRef = { dir: vaultRoot, url: `${server.url}/personal-kb.git`, branch: "main" };

    await engineA.adoptRemote(ref, "Set up personal knowledge base", { exclude: ["teams/some-lib"] });

    // Both sides merged, excluded library folder never committed.
    expect(fs.existsSync(path.join(vaultRoot, "old-notes.md"))).toBe(true);
    const changes = await engineA.localChanges(ref, { exclude: ["teams/some-lib"] });
    expect(changes).toEqual([]);
    const other: RepoRef = { dir: path.join(root, "kb-check"), url: ref.url, branch: "main" };
    await engineB.clone(other);
    expect(fs.existsSync(path.join(other.dir, "my-note.md"))).toBe(true);
    expect(fs.existsSync(path.join(other.dir, "teams", "some-lib"))).toBe(false);
  });

  it("opt-in include list: only marked paths sync to the personal repo", async () => {
    const bare = path.join(root, "optin-kb.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bare });

    const vaultRoot = path.join(root, "vault-optin");
    fs.mkdirSync(path.join(vaultRoot, "private"), { recursive: true });
    fs.mkdirSync(path.join(vaultRoot, "shared-notes"), { recursive: true });
    fs.mkdirSync(path.join(vaultRoot, ".covault"), { recursive: true });
    fs.writeFileSync(path.join(vaultRoot, "private", "diary.md"), "# secret\n");
    fs.writeFileSync(path.join(vaultRoot, "loose-note.md"), "# loose\n");
    fs.writeFileSync(path.join(vaultRoot, "shared-notes", "howto.md"), "# howto\n");
    fs.writeFileSync(path.join(vaultRoot, ".covault", "covault.json"), `{"version":1,"repos":[],"include":["shared-notes"]}\n`);
    const ref: RepoRef = { dir: vaultRoot, url: `${server.url}/optin-kb.git`, branch: "main" };

    await engineA.adoptRemote(ref, "Set up personal knowledge base", { include: ["shared-notes"] });

    const check: RepoRef = { dir: path.join(root, "optin-check"), url: ref.url, branch: "main" };
    await engineB.clone(check);
    expect(fs.existsSync(path.join(check.dir, "shared-notes", "howto.md"))).toBe(true);
    expect(fs.existsSync(path.join(check.dir, ".covault", "covault.json"))).toBe(true); // manifest propagates
    expect(fs.existsSync(path.join(check.dir, "private"))).toBe(false);
    expect(fs.existsSync(path.join(check.dir, "loose-note.md"))).toBe(false);

    // Unmarked edits stay invisible to change detection.
    fs.writeFileSync(path.join(vaultRoot, "private", "diary.md"), "# secret v2\n");
    expect(await engineA.localChanges(ref, { include: ["shared-notes"] })).toEqual([]);
    // Marked edits are seen.
    fs.writeFileSync(path.join(vaultRoot, "shared-notes", "howto.md"), "# howto v2\n");
    expect(await engineA.localChanges(ref, { include: ["shared-notes"] })).toEqual([
      { filepath: "shared-notes/howto.md", kind: "modified" },
    ]);
  });

  it("separate gitdir: a fully-tracked vault .git can't leak into the personal repo", async () => {
    const bare = path.join(root, "gitdir-kb.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bare });

    // A vault whose root is ALREADY a repo with everything tracked
    // (the agentic-git-sync scenario that leaked the whole vault).
    const vaultRoot = path.join(root, "vault-tracked");
    fs.mkdirSync(path.join(vaultRoot, "shared-notes"), { recursive: true });
    fs.writeFileSync(path.join(vaultRoot, "secret.md"), "# secret\n");
    fs.writeFileSync(path.join(vaultRoot, "shared-notes", "public.md"), "# public\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: vaultRoot });
    execFileSync("git", ["add", "."], { cwd: vaultRoot });
    execFileSync("git", ["-c", "user.name=v", "-c", "user.email=v@t", "commit", "-m", "vault"], { cwd: vaultRoot });

    const gitdir = path.join(vaultRoot, ".covault", "main.git");
    const ref: RepoRef = { dir: vaultRoot, url: `${server.url}/gitdir-kb.git`, branch: "main", gitdir };
    await engineA.adoptRemote(ref, "Set up personal knowledge base", { include: ["shared-notes"] });

    const check: RepoRef = { dir: path.join(root, "gitdir-check"), url: ref.url, branch: "main" };
    await engineB.clone(check);
    expect(fs.existsSync(path.join(check.dir, "shared-notes", "public.md"))).toBe(true);
    expect(fs.existsSync(path.join(check.dir, "secret.md"))).toBe(false); // tracked-by-vault-git yet private
    // And the vault's own .git was never touched: no covault commit on it.
    const log = execFileSync("git", ["log", "--oneline"], { cwd: vaultRoot }).toString();
    expect(log).not.toContain("personal knowledge base");
  });

  it("completes a conflicted merge after resolution (agent/manual path)", async () => {
    // Continues from the previous test: clientB has conflict markers in
    // glossary.md and a diverged local commit.
    const resolved = "# Glossary\n\nSP: story points (during sprint planning)\n";
    await engineB.writeWorkFile(refB, "glossary.md", resolved);
    await engineB.completeMerge(refB, ["glossary.md"], "merge: AI auto-resolved 1 conflict(s)");

    // A pulls the merge result.
    const follow = await engineA.syncToRemote(refA, { commitMessage: msg });
    expect(follow.pulled).toBe(true);
    expect(fs.readFileSync(path.join(refA.dir, "glossary.md"), "utf8")).toBe(resolved);

    // History of the file is visible, newest first, with the merge on top.
    const log = await engineB.fileLog(refB, "glossary.md");
    expect(log[0]?.message).toContain("AI auto-resolved");
    expect(log.length).toBeGreaterThanOrEqual(3);

    // And old content is retrievable for the diff view.
    const first = log[log.length - 1]!;
    const oldContent = await engineB.readFileAt(refB, first.hash, "glossary.md");
    expect(oldContent).toContain("SP: sprint");
  });

  it("discards a conflicted merge, restoring the local version", async () => {
    // Manufacture a fresh conflict between A and B.
    fs.writeFileSync(path.join(refA.dir, "glossary.md"), "# Glossary\n\nSP: version A\n");
    await engineA.syncToRemote(refA, { commitMessage: msg });
    fs.writeFileSync(path.join(refB.dir, "glossary.md"), "# Glossary\n\nSP: version B\n");
    const result = await engineB.syncToRemote(refB, { commitMessage: msg });
    expect(result.conflictFilepaths).toEqual(["glossary.md"]);

    await engineB.discardMerge(refB);
    const content = fs.readFileSync(path.join(refB.dir, "glossary.md"), "utf8");
    expect(content).not.toContain("<<<<<<<");
    expect(content).toContain("version B"); // back to the local commit
  });

  it("never commits leftover conflict markers — they re-enter the conflict pipeline", async () => {
    // Simulate a restart with an unresolved merge: markers sit in the file.
    fs.writeFileSync(
      path.join(refB.dir, "glossary.md"),
      "# Glossary\n\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> incoming\n",
    );
    const result = await engineB.syncToRemote(refB, { commitMessage: msg });
    expect(result.conflictFilepaths).toEqual(["glossary.md"]);
    expect(result.committed).toEqual([]);
    expect(result.pushed).toBe(false);
    // Clean up: restore the local version so later tests aren't polluted.
    await engineB.discardMerge(refB);
  });

  it("ignores .obsidian machinery", async () => {
    fs.mkdirSync(path.join(refA.dir, ".obsidian"), { recursive: true });
    fs.writeFileSync(path.join(refA.dir, ".obsidian", "workspace.json"), "{}");
    const changes = await engineA.localChanges(refA);
    expect(changes).toEqual([]);
  });
});

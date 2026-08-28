/**
 * Integration test: the full silent-sync flow (clone → edit → push → pull →
 * diverge → merge → conflict) against a real git smart-HTTP remote served
 * by `git http-backend` (see gitHttpServer.ts). Runs against Covault's own
 * Node transport — the same client the plugin uses — so the streaming and
 * idle-timeout code is exercised here rather than only in production.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// eslint-disable-next-line import/no-internal-modules
import * as git from "isomorphic-git";
import { createNodeHttp } from "../src/git/nodeHttp";
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
    http: createNodeHttp(),
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

  /**
   * The first download takes the tip only. A library is used at its head;
   * paying for the whole history up front is what made a large one slow to
   * set up and a 350 MB one fail. Pushing from a shallow clone still has
   * to work, which the next test covers.
   */
  it("clones shallow — one commit, marked shallow", async () => {
    expect(fs.existsSync(path.join(refA.dir, ".git", "shallow"))).toBe(true);
    const log = await git.log({ fs, dir: refA.dir });
    expect(log).toHaveLength(1);
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
    expect(result).toEqual({ committed: [], pulled: false, pushed: false, conflictFilepaths: [], lfsPending: 0 });
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

  it("adopts an existing remote by force-pulling it, keeping local copies", async () => {
    // Remote already has content (e.g. a personal-kb repo from another machine)…
    const bare = path.join(root, "personal-kb.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bare });
    const seed = path.join(root, "kb-seed");
    execFileSync("git", ["clone", bare, seed]);
    fs.writeFileSync(path.join(seed, "old-notes.md"), "# Old\n");
    fs.writeFileSync(path.join(seed, "both.md"), "# Remote wins\n");
    execFileSync("git", ["add", "."], { cwd: seed });
    execFileSync("git", ["-c", "user.name=s", "-c", "user.email=s@t", "commit", "-m", "seed"], { cwd: seed });
    execFileSync("git", ["push", "origin", "main"], { cwd: seed });

    // …and the local vault has its own content, one file overlapping.
    const vaultRoot = path.join(root, "vault-adopt");
    fs.mkdirSync(vaultRoot, { recursive: true });
    fs.writeFileSync(path.join(vaultRoot, "my-note.md"), "# Mine\n");
    fs.writeFileSync(path.join(vaultRoot, "both.md"), "# Local version\n");
    const ref: RepoRef = { dir: vaultRoot, url: `${server.url}/personal-kb.git`, branch: "main" };

    const backedUp = await engineA.adoptRemote(ref);

    // Remote content materialized; the overlapping file kept aside.
    expect(fs.existsSync(path.join(vaultRoot, "old-notes.md"))).toBe(true);
    expect(fs.readFileSync(path.join(vaultRoot, "both.md"), "utf8")).toContain("Remote wins");
    expect(backedUp).toHaveLength(1);
    expect(backedUp[0]).toMatch(/^both \(local copy \d{4}-\d{2}-\d{2} \d{2}-\d{2}\)\.md$/);
    expect(fs.readFileSync(path.join(vaultRoot, backedUp[0]!), "utf8")).toContain("Local version");
    // Local-only files survive untouched and uncommitted (nothing marked yet).
    expect(fs.existsSync(path.join(vaultRoot, "my-note.md"))).toBe(true);
    expect(await engineA.localChanges(ref, { include: [] })).toEqual([]);
    // Single lineage: the local branch is exactly the remote commit.
    const local = await engineA.fileLog(ref, "old-notes.md");
    expect(local[0]?.message).toBe("seed");
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

    await engineA.initAndPush(ref, "Set up personal knowledge base", { include: ["shared-notes"] });

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

  it("an existing but never-pushed-to remote has no branch to adopt — it gets seeded", async () => {
    // A repo created on GitHub (or by a half-finished earlier attempt)
    // and never pushed to: adopting it used to fail with
    // 'The remote has no "main" branch yet.'
    const bare = path.join(root, "empty-kb.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bare });

    const folder = path.join(root, "vault-empty-remote", "handbook");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "intro.md"), "# intro\n");
    const ref: RepoRef = { dir: folder, url: `${server.url}/empty-kb.git`, branch: "main" };

    expect(await engineA.remoteHasBranch(ref)).toBe(false);
    await expect(engineA.adoptRemote(ref)).rejects.toThrow(/no "main" branch/);

    // The caller's fallback: seed the empty remote from the folder.
    fs.rmSync(path.join(folder, ".git"), { recursive: true, force: true });
    await engineA.initAndPush(ref, "Share handbook as a knowledge library");
    expect(await engineA.remoteHasBranch(ref)).toBe(true);

    const check: RepoRef = { dir: path.join(root, "empty-check"), url: ref.url, branch: "main" };
    await engineB.clone(check);
    expect(fs.readFileSync(path.join(check.dir, "intro.md"), "utf8")).toContain("intro");
  });

  it("remoteDefaultBranch: reports the server's HEAD, or null for a branchless repo", async () => {
    // A knowledge base from before the main rename: content on master.
    const bare = path.join(root, "master-era-kb.git");
    execFileSync("git", ["init", "--bare", "-b", "master", bare]);
    execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bare });
    const seed = path.join(root, "master-era-seed");
    execFileSync("git", ["clone", bare, seed]);
    fs.writeFileSync(path.join(seed, "old.md"), "# old wisdom\n");
    execFileSync("git", ["add", "."], { cwd: seed });
    execFileSync("git", ["-c", "user.name=s", "-c", "user.email=s@t", "commit", "-m", "seed"], { cwd: seed });
    execFileSync("git", ["push", "origin", "master"], { cwd: seed });

    const dir = path.join(root, "master-era-dir");
    const probe: RepoRef = { dir, url: `${server.url}/master-era-kb.git`, branch: "main" };
    // Asking for "main" would find nothing — the server knows better.
    expect(await engineA.remoteHasBranch(probe)).toBe(false);
    expect(await engineA.remoteDefaultBranch(probe)).toBe("master");

    // And the branch it names is adoptable: content lands, single lineage.
    fs.mkdirSync(dir, { recursive: true });
    await engineA.adoptRemote({ ...probe, branch: "master" });
    expect(fs.readFileSync(path.join(dir, "old.md"), "utf8")).toContain("old wisdom");

    // A repo with no branches at all: nothing to adopt, seed instead.
    const empty = path.join(root, "branchless-kb.git");
    execFileSync("git", ["init", "--bare", "-b", "main", empty]);
    expect(
      await engineA.remoteDefaultBranch({ dir, url: `${server.url}/branchless-kb.git`, branch: "main" }),
    ).toBeNull();
  });

  it("seeds a folder that already carries a .git on another branch", async () => {
    // Sharing a folder that is already a git repo (a leftover attempt, or
    // something cloned into the vault — often still on "master") used to
    // commit onto that branch and then fail the push with
    // 'Could not find main.'
    const bare = path.join(root, "onmaster-kb.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bare });

    const folder = path.join(root, "vault-onmaster", "handbook");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "intro.md"), "# intro\n");
    execFileSync("git", ["init", "-b", "master"], { cwd: folder });
    const ref: RepoRef = { dir: folder, url: `${server.url}/onmaster-kb.git`, branch: "main" };

    await engineA.initAndPush(ref, "Share handbook as a knowledge library");

    const check: RepoRef = { dir: path.join(root, "onmaster-check"), url: ref.url, branch: "main" };
    await engineB.clone(check);
    expect(fs.readFileSync(path.join(check.dir, "intro.md"), "utf8")).toContain("intro");
  });

  it("reports the origin of a folder that already belongs to another repo", async () => {
    const folder = path.join(root, "vault-foreign", "clone");
    fs.mkdirSync(folder, { recursive: true });
    const ref: RepoRef = { dir: folder, url: `${server.url}/whatever.git`, branch: "main" };
    expect(await engineA.existingOrigin(ref)).toBeNull(); // not a repo yet

    execFileSync("git", ["init", "-b", "main"], { cwd: folder });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/someone/else.git"], { cwd: folder });
    expect(await engineA.existingOrigin(ref)).toBe("https://github.com/someone/else.git");
  });

  it("whole-vault scope: everything but the team libraries and vault machinery", async () => {
    const bare = path.join(root, "wholevault-kb.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bare });

    const vaultRoot = path.join(root, "vault-whole");
    fs.mkdirSync(path.join(vaultRoot, "private"), { recursive: true });
    fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
    fs.mkdirSync(path.join(vaultRoot, ".trash"), { recursive: true });
    fs.mkdirSync(path.join(vaultRoot, "team-kb"), { recursive: true });
    fs.writeFileSync(path.join(vaultRoot, "private", "diary.md"), "# no longer secret\n");
    fs.writeFileSync(path.join(vaultRoot, "loose-note.md"), "# loose\n");
    fs.writeFileSync(path.join(vaultRoot, ".obsidian", "workspace.json"), "{}\n");
    fs.writeFileSync(path.join(vaultRoot, ".trash", "deleted.md"), "# gone\n");
    fs.writeFileSync(path.join(vaultRoot, "team-kb", "handbook.md"), "# team\n");
    fs.mkdirSync(path.join(vaultRoot, ".covault", "skills"), { recursive: true });
    fs.writeFileSync(path.join(vaultRoot, ".covault", "skills", "team-knowledge.md"), "# derived\n");

    const gitdir = path.join(vaultRoot, ".covault", "main.git");
    const ref: RepoRef = { dir: vaultRoot, url: `${server.url}/wholevault-kb.git`, branch: "main", gitdir };
    // No `include` — whole-vault scope. "team-kb" is a library folder.
    await engineA.initAndPush(ref, "Set up personal knowledge base", { exclude: ["team-kb"] });

    const check: RepoRef = { dir: path.join(root, "wholevault-check"), url: ref.url, branch: "main" };
    await engineB.clone(check);
    expect(fs.existsSync(path.join(check.dir, "private", "diary.md"))).toBe(true);
    expect(fs.existsSync(path.join(check.dir, "loose-note.md"))).toBe(true);
    expect(fs.existsSync(path.join(check.dir, "team-kb"))).toBe(false); // the library owns it
    expect(fs.existsSync(path.join(check.dir, ".obsidian"))).toBe(false);
    expect(fs.existsSync(path.join(check.dir, ".trash"))).toBe(false);
    // The generated skill is per-device derived data — synced nowhere.
    expect(fs.existsSync(path.join(check.dir, ".covault", "skills"))).toBe(false);
  });

  it("whole-vault scope: a folder that becomes a library leaves the personal repo", async () => {
    const bare = path.join(root, "handover-kb.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bare });

    // A vault backed up whole, before any library exists.
    const vaultRoot = path.join(root, "vault-handover");
    fs.mkdirSync(path.join(vaultRoot, "handbook"), { recursive: true });
    fs.writeFileSync(path.join(vaultRoot, "note.md"), "# mine\n");
    fs.writeFileSync(path.join(vaultRoot, "handbook", "onboarding.md"), "# onboarding\n");

    const gitdir = path.join(vaultRoot, ".covault", "main.git");
    const ref: RepoRef = { dir: vaultRoot, url: `${server.url}/handover-kb.git`, branch: "main", gitdir };
    await engineA.initAndPush(ref, "Set up personal knowledge base", {});

    // Now "handbook" is shared as a team library: the personal repo must
    // hand it over instead of syncing the same notes twice.
    const changes = await engineA.localChanges(ref, { exclude: ["handbook"] });
    expect(changes).toEqual([{ filepath: "handbook/onboarding.md", kind: "deleted" }]);

    const result = await engineA.syncToRemote(ref, { commitMessage: msg, exclude: ["handbook"] });
    expect(result.committed).toHaveLength(1);

    const check: RepoRef = { dir: path.join(root, "handover-check"), url: ref.url, branch: "main" };
    await engineB.clone(check);
    expect(fs.existsSync(path.join(check.dir, "note.md"))).toBe(true);
    expect(fs.existsSync(path.join(check.dir, "handbook"))).toBe(false);
    // The notes themselves are untouched on disk — the library repo has them now.
    expect(fs.existsSync(path.join(vaultRoot, "handbook", "onboarding.md"))).toBe(true);
    // Idempotent: nothing left to hand over on the next round.
    expect(await engineA.localChanges(ref, { exclude: ["handbook"] })).toEqual([]);
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
    await engineA.initAndPush(ref, "Set up personal knowledge base", { include: ["shared-notes"] });

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

  /**
   * The "delete the local folder too" checkbox promises the team's copy on
   * GitHub covers everything; hasUnpushedWork is what keeps that promise
   * honest when sync has been failing and local work exists nowhere else.
   */
  describe("hasUnpushedWork", () => {
    let ref: RepoRef;

    beforeAll(async () => {
      const bare = path.join(root, "unpushed-kb.git");
      execFileSync("git", ["init", "--bare", "-b", "main", bare]);
      execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bare });
      const folder = path.join(root, "vault-unpushed");
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "note.md"), "# note\n");
      ref = { dir: folder, url: `${server.url}/unpushed-kb.git`, branch: "main" };
      await engineA.initAndPush(ref, "seed");
    });

    it("is false when everything reached the remote", async () => {
      expect(await engineA.hasUnpushedWork(ref)).toBe(false);
    });

    it("sees an uncommitted edit", async () => {
      fs.writeFileSync(path.join(ref.dir, "draft.md"), "# only here\n");
      expect(await engineA.hasUnpushedWork(ref)).toBe(true);
    });

    it("sees a committed-but-unpushed edit", async () => {
      await engineA.commitAll(ref, "local only", await engineA.localChanges(ref));
      expect(await engineA.hasUnpushedWork(ref)).toBe(true);
      // …and a push clears it.
      await engineA.push(ref);
      expect(await engineA.hasUnpushedWork(ref)).toBe(false);
    });

    it("treats a never-linked folder's content as unpushed, an empty or missing one as safe", async () => {
      const plain: RepoRef = { dir: path.join(root, "never-linked"), url: ref.url, branch: "main" };
      expect(await engineA.hasUnpushedWork(plain)).toBe(false); // no folder
      fs.mkdirSync(plain.dir, { recursive: true });
      expect(await engineA.hasUnpushedWork(plain)).toBe(false); // empty
      fs.writeFileSync(path.join(plain.dir, "note.md"), "# never synced\n");
      expect(await engineA.hasUnpushedWork(plain)).toBe(true);
    });
  });
});

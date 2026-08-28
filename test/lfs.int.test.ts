/**
 * Attachments end-to-end against a real smart-HTTP remote with an LFS
 * store (see gitHttpServer.ts): the engine converts attachments to
 * pointers on commit, uploads the bytes before pushing, a second client
 * materializes the original bytes, the working tree stays quiet after a
 * sync (pointer equivalence), and a conflicted attachment resolves itself
 * by keeping the local version.
 */
import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeHttp } from "../src/git/nodeHttp";
import { GitEngine, type RepoRef } from "../src/git/GitEngine";
import { PatTokenProvider } from "../src/auth/TokenProvider";
import { startGitServer, type GitServer } from "./gitHttpServer";

let root: string;
let server: GitServer;
let bare: string;
let engineA: GitEngine;
let engineB: GitEngine;
let refA: RepoRef;
let refB: RepoRef;

const msg = (changes: { filepath: string }[]) => `Update ${changes.length} file(s)`;
const POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

function makeEngine(name: string): GitEngine {
  return new GitEngine({
    fs,
    http: createNodeHttp(),
    tokens: new PatTokenProvider(() => ""),
    author: () => ({ name, email: `${name}@test.local` }),
    configDir: () => ".obsidian",
  });
}

/** What the remote repo itself holds at a path (via system git). */
function remoteFile(filepath: string): string {
  return execFileSync("git", ["cat-file", "-p", `main:${filepath}`], { cwd: bare }).toString("utf8");
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "covault-lfs-"));

  bare = path.join(root, "kb.git");
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bare });
  const seed = path.join(root, "seed");
  execFileSync("git", ["clone", bare, seed]);
  fs.writeFileSync(path.join(seed, "README.md"), "# KB\n");
  execFileSync("git", ["add", "."], { cwd: seed });
  execFileSync("git", ["-c", "user.name=seed", "-c", "user.email=seed@test.local", "commit", "-m", "seed"], {
    cwd: seed,
  });
  execFileSync("git", ["push", "origin", "main"], { cwd: seed });

  server = await startGitServer(root);
  const url = `${server.url}/kb.git`;
  refA = { dir: path.join(root, "clientA"), url, branch: "main" };
  refB = { dir: path.join(root, "clientB"), url, branch: "main" };
  engineA = makeEngine("alice");
  engineB = makeEngine("bob");
});

afterAll(async () => {
  await server?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("attachments ride Git LFS", () => {
  const original = crypto.randomBytes(2048);

  it("commits a pointer, ships the bytes to the LFS store, adds the CLI rule", async () => {
    await engineA.clone(refA);
    fs.writeFileSync(path.join(refA.dir, "picture.png"), original);

    const result = await engineA.syncToRemote(refA, { commitMessage: msg });
    expect(result.committed.map((c) => c.filepath)).toContain("picture.png");
    expect(result.pushed).toBe(true);

    // The repo holds a pointer, not pixels…
    const pointer = remoteFile("picture.png");
    expect(pointer).toContain(POINTER_PREFIX);
    expect(pointer).toContain("size 2048");
    // …the pixels live in the LFS store…
    const oid = /oid sha256:([0-9a-f]{64})/.exec(pointer)?.[1];
    expect(oid).toBeDefined();
    expect(fs.readFileSync(path.join(bare, "lfs-store", oid as string)).equals(original)).toBe(true);
    // …and plain git + git-lfs users get the same rule.
    expect(remoteFile(".gitattributes")).toContain("*.png filter=lfs diff=lfs merge=lfs -text");
    // The local working tree still holds the real bytes.
    expect(fs.readFileSync(path.join(refA.dir, "picture.png")).equals(original)).toBe(true);
  });

  it("stays quiet afterwards — the materialized file is not a change", async () => {
    expect(await engineA.localChanges(refA)).toEqual([]);
    const result = await engineA.syncToRemote(refA, { commitMessage: msg });
    expect(result).toEqual({ committed: [], pulled: false, pushed: false, conflictFilepaths: [], lfsPending: 0 });
  });

  it("materializes the original bytes on a second client", async () => {
    await engineB.clone(refB);
    expect(fs.readFileSync(path.join(refB.dir, "picture.png")).equals(original)).toBe(true);
    expect(await engineB.localChanges(refB)).toEqual([]);
  });

  it("propagates an edit to the attachment", async () => {
    const edited = crypto.randomBytes(4096);
    fs.writeFileSync(path.join(refA.dir, "picture.png"), edited);
    const pushed = await engineA.syncToRemote(refA, { commitMessage: msg });
    expect(pushed.committed.map((c) => c.filepath)).toEqual(["picture.png"]);

    const pulled = await engineB.syncToRemote(refB, { commitMessage: msg });
    expect(pulled.pulled).toBe(true);
    expect(fs.readFileSync(path.join(refB.dir, "picture.png")).equals(edited)).toBe(true);
  });

  it("resolves a conflicted attachment by keeping the local version", async () => {
    const fromAlice = crypto.randomBytes(1500);
    const fromBob = crypto.randomBytes(1600);
    fs.writeFileSync(path.join(refA.dir, "picture.png"), fromAlice);
    await engineA.syncToRemote(refA, { commitMessage: msg });

    // Bob edits without having pulled Alice's version: a true conflict.
    fs.writeFileSync(path.join(refB.dir, "picture.png"), fromBob);
    const result = await engineB.syncToRemote(refB, { commitMessage: msg });
    expect(result.conflictFilepaths).toEqual([]); // never reaches the AI/manual pipeline
    expect(result.pushed).toBe(true);
    expect(fs.readFileSync(path.join(refB.dir, "picture.png")).equals(fromBob)).toBe(true);

    // Alice picks up the merge — Bob's version won, hers is in history.
    const follow = await engineA.syncToRemote(refA, { commitMessage: msg });
    expect(follow.pulled).toBe(true);
    expect(fs.readFileSync(path.join(refA.dir, "picture.png")).equals(fromBob)).toBe(true);
    expect(remoteFile("picture.png")).toContain(POINTER_PREFIX);
  });

  it("migrates attachments an older version committed as raw blobs", async () => {
    // Seed through system git — exactly what pre-LFS Covault pushed.
    const bareLegacy = path.join(root, "legacy.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bareLegacy]);
    execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bareLegacy });
    const seed = path.join(root, "legacy-seed");
    execFileSync("git", ["clone", bareLegacy, seed]);
    const legacyBytes = crypto.randomBytes(2500);
    fs.writeFileSync(path.join(seed, "note.md"), "# note\n");
    fs.writeFileSync(path.join(seed, "old-scan.jpg"), legacyBytes);
    execFileSync("git", ["add", "."], { cwd: seed });
    execFileSync("git", ["-c", "user.name=s", "-c", "user.email=s@test.local", "commit", "-m", "raw era"], {
      cwd: seed,
    });
    execFileSync("git", ["push", "origin", "main"], { cwd: seed });

    const ref: RepoRef = { dir: path.join(root, "clientA-legacy"), url: `${server.url}/legacy.git`, branch: "main" };
    await engineA.clone(ref); // the raw blob checks out as-is, nothing to smudge
    expect(fs.readFileSync(path.join(ref.dir, "old-scan.jpg")).equals(legacyBytes)).toBe(true);

    expect(await engineA.migrateAttachments(ref)).toBe(1);
    const pushed = await engineA.syncToRemote(ref, { commitMessage: msg });
    expect(pushed.pushed).toBe(true);

    // The tip now holds a pointer, the bytes moved to the LFS store, and
    // the working tree never noticed.
    const pointer = execFileSync("git", ["cat-file", "-p", "main:old-scan.jpg"], { cwd: bareLegacy }).toString("utf8");
    expect(pointer).toContain(POINTER_PREFIX);
    const oid = /oid sha256:([0-9a-f]{64})/.exec(pointer)?.[1];
    expect(fs.readFileSync(path.join(bareLegacy, "lfs-store", oid as string)).equals(legacyBytes)).toBe(true);
    expect(fs.readFileSync(path.join(ref.dir, "old-scan.jpg")).equals(legacyBytes)).toBe(true);
    expect(await engineA.localChanges(ref)).toEqual([]);
    // Running it again finds nothing left to do.
    expect(await engineA.migrateAttachments(ref)).toBe(0);

    // A fresh client gets the original bytes back through the pointer.
    const refB2: RepoRef = { dir: path.join(root, "clientB-legacy"), url: ref.url, branch: "main" };
    await engineB.clone(refB2);
    expect(fs.readFileSync(path.join(refB2.dir, "old-scan.jpg")).equals(legacyBytes)).toBe(true);
  });

  it("works through a backlog in budgeted rounds, deferring the push", async () => {
    const bareBig = path.join(root, "backlog.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bareBig]);
    execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bareBig });

    const dir = path.join(root, "clientA-backlog");
    fs.mkdirSync(dir, { recursive: true });
    const originals: Buffer[] = [];
    for (let i = 0; i < 5; i++) {
      const bytes = crypto.randomBytes(1200);
      originals.push(bytes);
      fs.writeFileSync(path.join(dir, `photo-${i}.png`), bytes);
    }
    const ref: RepoRef = { dir, url: `${server.url}/backlog.git`, branch: "main" };
    await engineA.initAndPush(ref, "seed"); // unbudgeted path still ships everything

    // Now a second wave, synced with a budget so small every round ships
    // one object and defers the push.
    const wave: Buffer[] = [];
    for (let i = 0; i < 3; i++) {
      const bytes = crypto.randomBytes(1500);
      wave.push(bytes);
      fs.writeFileSync(path.join(dir, `scan-${i}.jpg`), bytes);
    }
    const first = await engineA.syncToRemote(ref, { commitMessage: msg, lfsBudgetBytes: 1 });
    expect(first.pushed).toBe(false);
    expect(first.lfsPending).toBeGreaterThan(0);
    // The commit exists locally; the remote must not see its pointers yet.
    expect(() => execFileSync("git", ["cat-file", "-p", "main:scan-0.jpg"], { cwd: bareBig })).toThrow();

    // Rounds compose: pending shrinks until a round finally pushes.
    let pending = first.lfsPending;
    for (let round = 0; round < 10 && pending > 0; round++) {
      const next = await engineA.syncToRemote(ref, { commitMessage: msg, lfsBudgetBytes: 1 });
      expect(next.lfsPending).toBeLessThan(pending);
      pending = next.lfsPending;
      if (pending === 0) expect(next.pushed).toBe(true);
    }
    expect(pending).toBe(0);
    expect(execFileSync("git", ["cat-file", "-p", "main:scan-2.jpg"], { cwd: bareBig }).toString("utf8")).toContain(
      POINTER_PREFIX,
    );

    // And a fresh clone materializes both waves.
    const refB3: RepoRef = { dir: path.join(root, "clientB-backlog"), url: ref.url, branch: "main" };
    await engineB.clone(refB3);
    expect(fs.readFileSync(path.join(refB3.dir, "photo-4.png")).equals(originals[4] as Buffer)).toBe(true);
    expect(fs.readFileSync(path.join(refB3.dir, "scan-1.jpg")).equals(wave[1] as Buffer)).toBe(true);
  });

  it("shares a brand-new folder with attachments via initAndPush", async () => {
    const bareLib = path.join(root, "lib.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bareLib]);
    execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bareLib });

    const dir = path.join(root, "clientA-lib");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "guide.md"), "# Guide\n");
    const slides = crypto.randomBytes(3000);
    fs.writeFileSync(path.join(dir, "slides.pdf"), slides);

    const refLib: RepoRef = { dir, url: `${server.url}/lib.git`, branch: "main" };
    await engineA.initAndPush(refLib, "Share library");

    const pointer = execFileSync("git", ["cat-file", "-p", "main:slides.pdf"], { cwd: bareLib }).toString("utf8");
    expect(pointer).toContain(POINTER_PREFIX);
    const oid = /oid sha256:([0-9a-f]{64})/.exec(pointer)?.[1];
    expect(fs.readFileSync(path.join(bareLib, "lfs-store", oid as string)).equals(slides)).toBe(true);
  });
});

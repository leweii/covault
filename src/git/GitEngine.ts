/**
 * All isomorphic-git access lives here. One engine instance serves every
 * synced repo; each call takes a RepoRef naming the repo it operates on.
 *
 * fs/http are injected: the plugin passes Node's fs (desktop-only) and the
 * streaming Node transport; the integration test passes the same pair
 * against a local git http-backend.
 */
import * as git from "isomorphic-git";
import type { HttpClient } from "isomorphic-git";
import type { TokenProvider } from "../auth/TokenProvider";
import type { DebugLog } from "../debug/logger";
import { ownerFromUrl } from "./urls";
import {
  LfsClient,
  type LfsPointer,
  POINTER_MAX_BYTES,
  formatPointer,
  gitattributesLines,
  isLfsPath,
  parsePointer,
  sha256Bytes,
  sha256File,
} from "./lfs";

export interface RepoRef {
  /** Absolute path of the working directory on disk. */
  dir: string;
  url: string;
  branch: string;
  /**
   * Separate git directory (absolute). The personal main repo keeps its
   * state in <vault>/.covault/main.git instead of <vault>/.git: a fresh
   * repo whose tree only ever contains opt-in content (a pre-existing
   * vault .git would drag every already-tracked file into the first
   * commit), and no fights with other tools managing the vault's .git.
   */
  gitdir?: string;
}

export interface Author {
  name: string;
  email: string;
}

export interface GitEngineDeps {
  fs: typeof import("fs");
  http: HttpClient;
  tokens: TokenProvider;
  author: () => Author;
  /** Obsidian's config folder name (Vault#configDir — user-configurable). */
  configDir: () => string;
  /** Diagnostics, when the user turned debug mode on. */
  log?: DebugLog;
}

export type ChangeKind = "added" | "modified" | "deleted";
export interface LocalChange {
  filepath: string;
  kind: ChangeKind;
}

export interface FileCommit {
  hash: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  date: Date;
}

export interface SyncResult {
  /** Files committed locally this round. */
  committed: LocalChange[];
  /** Remote had news and the working tree was updated. */
  pulled: boolean;
  /** Local commits were sent to the remote. */
  pushed: boolean;
  /** Non-empty means the merge stopped on these files (conflict markers
   *  are in the working tree; resolution is the agent's job — M4). */
  conflictFilepaths: string[];
}

/** "notes/plan.md" → "notes/plan (local copy 2026-08-13 17-42).md" — the
 *  stamp keeps repeat setups from clobbering an earlier backup and tells
 *  the user when the copy was taken. */
function backupNameFor(filepath: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` + `${p(now.getHours())}-${p(now.getMinutes())}`;
  const tag = `(local copy ${stamp})`;
  const dot = filepath.lastIndexOf(".");
  const slash = filepath.lastIndexOf("/");
  return dot > slash ? `${filepath.slice(0, dot)} ${tag}${filepath.slice(dot)}` : `${filepath} ${tag}`;
}

function dirnameOf(absolutePath: string): string {
  const slash = absolutePath.lastIndexOf("/");
  return slash <= 0 ? "/" : absolutePath.slice(0, slash);
}

/** All three git conflict markers at line starts — a note merely *talking*
 *  about git (one marker in a code block) doesn't trip this. */
function hasConflictMarkers(content: string): boolean {
  return /^<<<<<<< /m.test(content) && /^=======$/m.test(content) && /^>>>>>>> /m.test(content);
}

/** Vault paths that must never be committed into a knowledge repo.
 *  (.covault/covault.json is NOT excluded: it must ride along in the
 *  main repo — that's how libraries/marks propagate across machines.
 *  .covault/main.git IS: it's the main repo's own git directory, and so
 *  are the debug logs — local diagnostics, and they can be large. The
 *  Obsidian config folder is appended per-engine via deps.configDir.) */
const ALWAYS_EXCLUDED = [".trash", ".covault/main.git", ".covault/skills", ".covault/logs"];

export class GitEngine {
  private lfs: LfsClient;
  /**
   * sha256 of working-tree attachments, keyed by absolute path and guarded
   * by (size, mtime). Pointer equivalence needs the content hash on every
   * status scan; without the guard each scan would re-read every attachment.
   */
  private contentSha = new Map<string, { size: number; mtimeMs: number; oid: string }>();
  /**
   * LFS objects a remote is known to hold ("url#oid"), seeded by successful
   * batches, uploads and downloads — lets a steady-state push skip the LFS
   * round-trip entirely. In-memory only: losing it costs one extra batch
   * request, never correctness (the server re-reports what it has).
   */
  private onServer = new Set<string>();

  constructor(private deps: GitEngineDeps) {
    this.lfs = new LfsClient({ http: deps.http, tokens: deps.tokens, log: deps.log });
  }

  private auth(ref: RepoRef) {
    return {
      onAuth: async () => ({
        username: this.deps.tokens.gitUser(),
        password: await this.deps.tokens.getTokenForOwner(ownerFromUrl(ref.url)),
      }),
      onAuthFailure: () => ({ cancel: true }),
    };
  }

  private common(ref: RepoRef) {
    const { fs, http } = this.deps;
    return {
      fs,
      http,
      dir: ref.dir,
      gitdir: ref.gitdir,
      ...this.auth(ref),
    };
  }

  // ── Attachments (Git LFS) ────────────────────────────────────────────
  //
  // isomorphic-git has no clean/smudge filters, so the engine does the
  // conversion at every boundary: stage() turns attachments into pointers
  // on the way into the index, smudge() turns pointers back into bytes
  // after anything that writes the working tree from git, and push()
  // uploads objects before the commits referencing them become visible —
  // the repo never holds a pointer whose content isn't already resolvable.

  private gitdirOf(ref: RepoRef): string {
    return ref.gitdir ?? `${ref.dir}/.git`;
  }

  /** git-lfs's own cache layout, so a checkout by real git-lfs shares it. */
  private lfsCachePath(ref: RepoRef, oid: string): string {
    return `${this.gitdirOf(ref)}/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;
  }

  /** Content hash of a working-tree file, or null when it's missing. */
  private async workFileSha(ref: RepoRef, filepath: string): Promise<LfsPointer | null> {
    const { fs } = this.deps;
    const absolute = `${ref.dir}/${filepath}`;
    let stat: { size: number; mtimeMs: number };
    try {
      stat = await fs.promises.stat(absolute);
    } catch {
      return null;
    }
    const hit = this.contentSha.get(absolute);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return { oid: hit.oid, size: hit.size };
    const hashed = await sha256File(fs, absolute);
    this.contentSha.set(absolute, { size: hashed.size, mtimeMs: stat.mtimeMs, oid: hashed.oid });
    return hashed;
  }

  /** Remember a file we just wrote, so the next scan doesn't re-hash it. */
  private async noteSha(absolute: string, oid: string): Promise<void> {
    try {
      const stat = await this.deps.fs.promises.stat(absolute);
      this.contentSha.set(absolute, { size: stat.size, mtimeMs: stat.mtimeMs, oid });
    } catch {
      // the file vanished under us — nothing to remember
    }
  }

  /** The LFS pointer a commit holds for this path, or null (absent / raw blob). */
  private async readPointerAt(ref: RepoRef, commitOid: string, filepath: string): Promise<LfsPointer | null> {
    const blob = await this.readBlobAt(ref, commitOid, filepath);
    if (!blob || blob.byteLength > POINTER_MAX_BYTES) return null;
    return parsePointer(new TextDecoder().decode(blob));
  }

  private async readBlobAt(ref: RepoRef, commitOid: string, filepath: string): Promise<Uint8Array | null> {
    try {
      const { blob } = await git.readBlob({ fs: this.deps.fs, dir: ref.dir, gitdir: ref.gitdir, oid: commitOid, filepath });
      return blob;
    } catch {
      return null;
    }
  }

  /**
   * Stage one added/modified file, converting attachments to LFS pointers.
   *
   * git.add hashes whatever the working tree holds, which for an attachment
   * is the pixels themselves — exactly what must stay out of the repo. So
   * attachments go in sideways: hash the content, keep a copy in the LFS
   * cache (it's the upload source), and put a pointer blob at the path via
   * updateIndex. A working-tree file that already *is* pointer text (a
   * never-materialized file, or a resolved attachment conflict) is staged
   * as-is — its content is the pointer.
   */
  private async stage(ref: RepoRef, filepath: string): Promise<void> {
    const { fs } = this.deps;
    const common = { fs, dir: ref.dir, gitdir: ref.gitdir };
    if (!isLfsPath(filepath)) {
      await git.add({ ...common, filepath });
      return;
    }
    const absolute = `${ref.dir}/${filepath}`;
    const stat = await fs.promises.stat(absolute);
    if (stat.size <= POINTER_MAX_BYTES && parsePointer(await fs.promises.readFile(absolute, "utf8"))) {
      await git.add({ ...common, filepath });
      return;
    }
    const pointer = (await this.workFileSha(ref, filepath))!;
    const cachePath = this.lfsCachePath(ref, pointer.oid);
    try {
      await fs.promises.access(cachePath);
    } catch {
      await fs.promises.mkdir(dirnameOf(cachePath), { recursive: true });
      await fs.promises.copyFile(absolute, cachePath);
    }
    const blobOid = await git.writeBlob({
      fs,
      dir: ref.dir,
      gitdir: ref.gitdir,
      blob: new TextEncoder().encode(formatPointer(pointer)),
    });
    await git.updateIndex({ ...common, filepath, oid: blobOid, add: true });
  }

  private static readonly GITATTRIBUTES_MARK = "# Covault: attachments are stored with Git LFS";

  /**
   * Make the LFS rule visible to plain git + git-lfs users. Covault itself
   * never reads .gitattributes (stage() is the rule); this is interop, so
   * a teammate's CLI clone treats the same extensions the same way.
   * Returns true when the file changed and needs staging.
   */
  private async ensureGitattributes(ref: RepoRef): Promise<boolean> {
    const { fs } = this.deps;
    const absolute = `${ref.dir}/.gitattributes`;
    let existing = "";
    try {
      existing = await fs.promises.readFile(absolute, "utf8");
    } catch {
      // none yet
    }
    if (existing.includes(GitEngine.GITATTRIBUTES_MARK)) return false;
    const block = [GitEngine.GITATTRIBUTES_MARK, ...gitattributesLines()].join("\n") + "\n";
    await fs.promises.writeFile(absolute, existing ? `${existing.replace(/\n*$/, "\n")}\n${block}` : block);
    return true;
  }

  /**
   * Materialize LFS pointers in the working tree: cache first, then one
   * batch download for the rest. Runs after anything that writes the tree
   * from git, and once per sync round as a repair pass (a download that
   * failed last time must not strand pointer text in the vault forever).
   * A missing local file is a deletion in progress, not smudge's business.
   */
  private async smudge(ref: RepoRef): Promise<void> {
    const { fs } = this.deps;
    const candidates = (await git.listFiles({ fs, dir: ref.dir, gitdir: ref.gitdir })).filter(isLfsPath);
    if (candidates.length === 0) return;

    const wanted: { filepath: string; pointer: LfsPointer }[] = [];
    for (const filepath of candidates) {
      const absolute = `${ref.dir}/${filepath}`;
      let stat: { size: number };
      try {
        stat = await fs.promises.stat(absolute);
      } catch {
        continue;
      }
      if (stat.size > POINTER_MAX_BYTES) continue; // already content
      const pointer = parsePointer(await fs.promises.readFile(absolute, "utf8"));
      if (pointer) wanted.push({ filepath, pointer });
    }
    if (wanted.length === 0) return;

    const missing = new Map<string, { size: number; filepaths: string[] }>();
    for (const { filepath, pointer } of wanted) {
      const absolute = `${ref.dir}/${filepath}`;
      try {
        await fs.promises.copyFile(this.lfsCachePath(ref, pointer.oid), absolute);
        await this.noteSha(absolute, pointer.oid);
      } catch {
        const entry = missing.get(pointer.oid) ?? { size: pointer.size, filepaths: [] };
        entry.filepaths.push(filepath);
        missing.set(pointer.oid, entry);
      }
    }
    if (missing.size === 0) return;

    const done = this.deps.log?.opTime("lfs", `${ref.dir} — download attachments`, { objects: missing.size });
    const objects = await this.lfs.batch(
      ref.url,
      ref.branch,
      "download",
      [...missing].map(([oid, m]) => ({ oid, size: m.size })),
    );
    const failed: string[] = [];
    for (const object of objects) {
      const entry = missing.get(object.oid);
      if (!entry) continue;
      let data: Buffer;
      try {
        data = await this.lfs.download(object);
      } catch (e) {
        this.deps.log?.op("lfs", `download failed for ${entry.filepaths[0] ?? object.oid}`, { error: e });
        failed.push(...entry.filepaths);
        continue;
      }
      this.onServer.add(`${ref.url}#${object.oid}`);
      const cachePath = this.lfsCachePath(ref, object.oid);
      await fs.promises.mkdir(dirnameOf(cachePath), { recursive: true });
      await fs.promises.writeFile(cachePath, data);
      for (const filepath of entry.filepaths) {
        const absolute = `${ref.dir}/${filepath}`;
        await fs.promises.copyFile(cachePath, absolute);
        await this.noteSha(absolute, object.oid);
      }
    }
    done?.({ failed: failed.length });
    if (failed.length > 0) {
      throw new Error(`Couldn't download ${failed.length} attachment(s) (first: ${failed[0]}) — will retry next sync.`);
    }
  }

  /**
   * The reverse of smudge: put pointer text back over attachments whose
   * bytes still match their pointer. isomorphic-git's checkout compares
   * the working tree to the index, so a materialized attachment looks like
   * a local edit and blocks every pull — this runs right before git writes
   * the tree (fast-forward, merge) and smudge() re-materializes right
   * after. A genuinely edited attachment is left alone: it was committed
   * earlier in the round, or it is a mid-round race checkout should stop on.
   */
  private async dematerialize(ref: RepoRef): Promise<void> {
    const { fs } = this.deps;
    const head = await this.resolve(ref, "HEAD");
    if (!head) return;
    for (const filepath of (await git.listFiles({ fs, dir: ref.dir, gitdir: ref.gitdir })).filter(isLfsPath)) {
      const pointer = await this.readPointerAt(ref, head, filepath);
      if (!pointer) continue;
      const work = await this.workFileSha(ref, filepath);
      if (!work || work.oid !== pointer.oid) continue;
      // Replacing the only copy would be destructive — make sure the cache
      // holds the bytes first (it should already, but this is the backstop).
      const absolute = `${ref.dir}/${filepath}`;
      const cachePath = this.lfsCachePath(ref, pointer.oid);
      try {
        await fs.promises.access(cachePath);
      } catch {
        await fs.promises.mkdir(dirnameOf(cachePath), { recursive: true });
        await fs.promises.copyFile(absolute, cachePath);
      }
      await fs.promises.writeFile(absolute, formatPointer(pointer));
    }
  }

  /**
   * Ship every LFS object the branch tip references before its commits do
   * — push-before-upload would publish pointers no one can resolve. One
   * batch tells us what the server lacks; objects we can't source locally
   * (a pointer minted on another device) are skipped, since the device
   * that minted them uploads before it pushes.
   */
  private async uploadLfs(ref: RepoRef): Promise<void> {
    const { fs } = this.deps;
    const tip = await this.resolve(ref, `refs/heads/${ref.branch}`);
    if (!tip) return;
    const tracked = (await git.listFiles({ fs, dir: ref.dir, gitdir: ref.gitdir, ref: tip })).filter(isLfsPath);
    if (tracked.length === 0) return;

    const pointers = new Map<string, { size: number; filepaths: string[] }>();
    for (const filepath of tracked) {
      const pointer = await this.readPointerAt(ref, tip, filepath);
      if (!pointer) continue; // a raw pre-LFS blob — travels inside the pack as before
      const entry = pointers.get(pointer.oid) ?? { size: pointer.size, filepaths: [] };
      entry.filepaths.push(filepath);
      pointers.set(pointer.oid, entry);
    }
    const unknown = [...pointers].filter(([oid]) => !this.onServer.has(`${ref.url}#${oid}`));
    if (unknown.length === 0) return;

    const done = this.deps.log?.opTime("lfs", `${ref.dir} — upload attachments`, { objects: unknown.length });
    const objects = await this.lfs.batch(
      ref.url,
      ref.branch,
      "upload",
      unknown.map(([oid, m]) => ({ oid, size: m.size })),
    );
    let uploaded = 0;
    for (const object of objects) {
      const entry = pointers.get(object.oid);
      if (!entry) continue;
      if (!object.actions?.upload) {
        if (!object.error) this.onServer.add(`${ref.url}#${object.oid}`);
        continue;
      }
      const data = await this.lfsObjectBytes(ref, object.oid, entry.filepaths);
      if (!data) {
        this.deps.log?.op("lfs", `no local bytes for ${object.oid.slice(0, 8)}… — skipped`, {
          filepath: entry.filepaths[0],
        });
        continue;
      }
      await this.lfs.upload(ref.url, object, data);
      this.onServer.add(`${ref.url}#${object.oid}`);
      uploaded++;
    }
    done?.({ uploaded });
  }

  /**
   * One-off backlog migration: convert attachments that earlier versions
   * committed as raw blobs into LFS pointers, in a single commit. Only the
   * branch tip changes — history keeps the old blobs, because rewriting it
   * would force-push over every teammate's clone. New and edited
   * attachments convert on their own during normal syncs; this exists for
   * what was already tracked. Commits only — the caller runs a normal sync
   * round afterwards so pushing (and any merge) follows the usual path.
   * Returns how many files were converted.
   */
  async migrateAttachments(ref: RepoRef): Promise<number> {
    const { fs } = this.deps;
    const head = await this.resolve(ref, "HEAD");
    if (!head) return 0;
    const raw: LocalChange[] = [];
    for (const filepath of (await git.listFiles({ fs, dir: ref.dir, gitdir: ref.gitdir })).filter(isLfsPath)) {
      if (await this.readPointerAt(ref, head, filepath)) continue; // already a pointer
      try {
        await fs.promises.access(`${ref.dir}/${filepath}`);
      } catch {
        continue; // deleted locally — the next sync owns that story
      }
      raw.push({ filepath, kind: "modified" });
    }
    if (raw.length === 0) return 0;
    const done = this.deps.log?.opTime("lfs", `${ref.dir} — migrate attachments`, { files: raw.length });
    await this.commitAll(ref, `Move ${raw.length} attachment(s) to Git LFS`, raw);
    done?.();
    return raw.length;
  }

  /** An object's bytes: the cache, else a working-tree file that still matches. */
  private async lfsObjectBytes(ref: RepoRef, oid: string, filepaths: string[]): Promise<Buffer | null> {
    const { fs } = this.deps;
    try {
      return await fs.promises.readFile(this.lfsCachePath(ref, oid));
    } catch {
      // not cached — fall through to the working tree
    }
    for (const filepath of filepaths) {
      const sha = await this.workFileSha(ref, filepath);
      if (sha?.oid === oid) return fs.promises.readFile(`${ref.dir}/${filepath}`);
    }
    return null;
  }

  /**
   * Does the remote have this branch yet? A repo that exists but was
   * never pushed to — freshly created on GitHub, or left behind by a
   * half-finished earlier attempt — has no branch at all: there is
   * nothing to clone or adopt, and the local side has to seed it.
   */
  async remoteHasBranch(ref: RepoRef): Promise<boolean> {
    const refs = await git.listServerRefs({
      http: this.deps.http,
      url: ref.url,
      prefix: `refs/heads/${ref.branch}`,
      ...this.auth(ref),
    });
    return refs.length > 0;
  }

  /**
   * The remote's default branch ("main", "master", …), or null when the
   * repo has no branches at all. Asking the server beats assuming "main":
   * a knowledge base that predates the rename would otherwise grow a
   * parallel empty main while its real content sits on master.
   */
  async remoteDefaultBranch(ref: RepoRef): Promise<string | null> {
    const refs = await git.listServerRefs({
      http: this.deps.http,
      url: ref.url,
      prefix: "HEAD",
      symrefs: true,
      ...this.auth(ref),
    });
    const target = refs.find((r) => r.ref === "HEAD")?.target;
    return target?.startsWith("refs/heads/") ? target.slice("refs/heads/".length) : null;
  }

  /**
   * How much history the first download brings: just the tip.
   *
   * A knowledge library is read and edited at its head; its history is for
   * the occasional "who changed this note", which fileLog deepens on
   * demand. Paying for all of it up front is what made a large or old
   * library slow to set up, and 350 MB of it is what made one fail
   * outright. Later fetches grow the history naturally.
   */
  private static readonly FIRST_FETCH_DEPTH = 1;

  async clone(ref: RepoRef): Promise<void> {
    const done = this.deps.log?.opTime("clone", ref.dir, {
      branch: ref.branch,
      depth: GitEngine.FIRST_FETCH_DEPTH,
    });
    await git.clone({
      ...this.common(ref),
      url: ref.url,
      ref: ref.branch,
      singleBranch: true,
      depth: GitEngine.FIRST_FETCH_DEPTH,
    });
    await this.smudge(ref);
    done?.();
  }

  /**
   * Turn an existing folder into a repo and ship it: init on the target
   * branch, point origin at the (empty) remote, commit everything, push.
   * Idempotent enough to retry after a partial failure.
   */
  async initAndPush(
    ref: RepoRef,
    message: string,
    opts: { exclude?: string[]; include?: string[] } = {},
  ): Promise<void> {
    const { fs } = this.deps;
    const done = this.deps.log?.opTime("init-push", ref.dir, { branch: ref.branch });
    await fs.promises.mkdir(ref.dir, { recursive: true }); // may be a folder-to-be
    await git.init({ fs, dir: ref.dir, gitdir: ref.gitdir, defaultBranch: ref.branch });
    // init leaves an existing HEAD alone, and a folder can arrive with one
    // (a leftover from a failed attempt, or a repo someone cloned into the
    // vault, often still on "master"). Without this the commit lands on
    // that branch and the push looks for one that was never written.
    await git.writeRef({
      fs,
      dir: ref.dir,
      gitdir: ref.gitdir,
      ref: "HEAD",
      value: `refs/heads/${ref.branch}`,
      symbolic: true,
      force: true,
    });
    await git.addRemote({ fs, dir: ref.dir, gitdir: ref.gitdir, remote: "origin", url: ref.url, force: true });
    const changes = await this.localChanges(ref, opts);
    const hasHead = (await this.resolve(ref, "HEAD")) !== null;
    if (changes.length > 0 || !hasHead) {
      await this.commitAll(ref, message, changes);
    }
    await this.push(ref);
    done?.({ files: changes.length });
  }

  /**
   * Bind a content-bearing folder (typically the vault root) to a remote
   * that already has history, taking the remote as the truth.
   *
   * Deliberately never merges: the two sides share no history, so a merge
   * would conflict on every overlapping file — and this runs during setup,
   * before the user has necessarily configured an AI provider to resolve
   * anything. Instead the local branch is pointed at the remote and
   * checked out; a local file the remote would overwrite is copied aside
   * first ("note (local copy).md") so nothing is lost silently.
   *
   * Local files the remote doesn't have are untouched and uncommitted —
   * the next sync ships whichever of them are marked for sharing, as a
   * plain fast-forward.
   */
  async adoptRemote(ref: RepoRef, opts: { onBackup?: (path: string) => void } = {}): Promise<string[]> {
    const { fs } = this.deps;
    const done = this.deps.log?.opTime("adopt", ref.dir, { branch: ref.branch });
    await git.init({ fs, dir: ref.dir, gitdir: ref.gitdir, defaultBranch: ref.branch });
    await git.addRemote({ fs, dir: ref.dir, gitdir: ref.gitdir, remote: "origin", url: ref.url, force: true });
    // Shallow for the same reason clone() is: the repo was just init'd, so
    // this is a first download with nothing local to negotiate against.
    await git.fetch({
      ...this.common(ref),
      remote: "origin",
      ref: ref.branch,
      singleBranch: true,
      depth: GitEngine.FIRST_FETCH_DEPTH,
    });

    const remote = await this.resolve(ref, `refs/remotes/origin/${ref.branch}`);
    if (!remote) throw new Error(`The remote has no "${ref.branch}" branch yet.`);

    // Preserve local versions of files the remote checkout would replace.
    const backedUp: string[] = [];
    for (const filepath of await git.listFiles({ fs, dir: ref.dir, gitdir: ref.gitdir, ref: remote })) {
      const absolute = `${ref.dir}/${filepath}`;
      if (isLfsPath(filepath)) {
        // Attachments compare by content hash (the remote side is usually a
        // pointer) and back up with a byte-safe copy — a utf8 round trip
        // would corrupt the pixels the backup exists to preserve.
        const local = await this.workFileSha(ref, filepath);
        if (!local) continue; // not present locally — the checkout just creates it
        const incoming = await this.readPointerAt(ref, remote, filepath);
        let same = incoming?.oid === local.oid;
        if (!incoming) {
          const raw = await this.readBlobAt(ref, remote, filepath); // a raw pre-LFS blob
          same = raw !== null && sha256Bytes(raw) === local.oid;
        }
        if (same) continue;
        const backupPath = backupNameFor(filepath);
        await fs.promises.mkdir(dirnameOf(`${ref.dir}/${backupPath}`), { recursive: true });
        await fs.promises.copyFile(absolute, `${ref.dir}/${backupPath}`);
        backedUp.push(backupPath);
        opts.onBackup?.(backupPath);
        continue;
      }
      let local: string;
      try {
        local = await fs.promises.readFile(absolute, "utf8");
      } catch {
        continue; // not present locally — the checkout just creates it
      }
      const incoming = await this.readFileAt(ref, remote, filepath);
      if (incoming === null || incoming === local) continue;
      const backupPath = backupNameFor(filepath);
      await fs.promises.mkdir(dirnameOf(`${ref.dir}/${backupPath}`), { recursive: true });
      await fs.promises.writeFile(`${ref.dir}/${backupPath}`, local);
      backedUp.push(backupPath);
      opts.onBackup?.(backupPath);
    }

    await git.writeRef({
      fs,
      dir: ref.dir,
      gitdir: ref.gitdir,
      ref: `refs/heads/${ref.branch}`,
      value: remote,
      force: true,
    });
    await git.checkout({ fs, dir: ref.dir, gitdir: ref.gitdir, ref: ref.branch, force: true });
    await this.smudge(ref);
    done?.({ backedUp: backedUp.length });
    return backedUp;
  }

  /** The folder's current origin, if it is already a git repo — a folder
   *  someone cloned into the vault must not have its remote hijacked. */
  async existingOrigin(ref: RepoRef): Promise<string | null> {
    try {
      const url = await git.getConfig({
        fs: this.deps.fs,
        dir: ref.dir,
        gitdir: ref.gitdir,
        path: "remote.origin.url",
      });
      return typeof url === "string" && url ? url : null;
    } catch {
      return null; // not a repo yet
    }
  }

  async isRepo(ref: RepoRef): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.deps.fs, dir: ref.dir, gitdir: ref.gitdir, ref: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Work the remote doesn't have: uncommitted changes in the tree, or
   * commits the remote branch lacks. Deleting a folder that holds either
   * loses the only copy, whatever the remove dialog promises about the
   * team's copy being safe. Unreadable state counts as unpushed — not
   * being able to tell is no license to delete.
   */
  async hasUnpushedWork(ref: RepoRef): Promise<boolean> {
    const { fs } = this.deps;
    try {
      if (!(await this.isRepo(ref))) {
        // Never became a repo (or an interrupted clone): nothing was ever
        // pushed from here, so any content is local-only.
        let entries: string[];
        try {
          entries = (await fs.promises.readdir(ref.dir)) as string[];
        } catch {
          return false; // no folder — nothing to lose
        }
        return entries.some((name) => name !== ".git");
      }
      if ((await this.localChanges(ref)).length > 0) return true;
      const local = await this.resolve(ref, `refs/heads/${ref.branch}`);
      if (!local) return true; // HEAD is on some other branch — can't vouch for it
      const remote = await this.resolve(ref, `refs/remotes/origin/${ref.branch}`);
      if (remote === local) return false;
      if (!remote) return true; // committed, never pushed
      // Pushed iff the remote already contains the local head.
      return !(await git.isDescendent({ fs, dir: ref.dir, gitdir: ref.gitdir, oid: remote, ancestor: local, depth: -1 }));
    } catch {
      return true;
    }
  }

  /**
   * Uncommitted work-tree changes.
   *
   * `exclude` drops nested synced repos and vault machinery (statusMatrix
   * would otherwise report a nested repo's files as new — isomorphic-git
   * #761). `include`, when given, flips the repo to opt-in: only paths
   * under the list (plus .covault, so the manifest propagates) are seen
   * at all. Omitting it means the whole work tree minus the exclusions —
   * what the personal repo uses in whole-vault scope.
   *
   * Files already tracked under an `exclude` path come back as deletions:
   * a folder that became a team library belongs to that library now, and
   * the same note must not live in two repos. The deletion is index-only
   * (see commitAll) — the file itself stays on disk.
   */
  async localChanges(ref: RepoRef, opts: { exclude?: string[]; include?: string[] } = {}): Promise<LocalChange[]> {
    const excluded = [...ALWAYS_EXCLUDED, this.deps.configDir(), ...(opts.exclude ?? [])];
    const include = opts.include;
    const matrix = await git.statusMatrix({
      fs: this.deps.fs,
      dir: ref.dir,
      gitdir: ref.gitdir,
      filter: (f) => {
        // Exclusion is evaluated first — no include value can leak a
        // nested library (or vault machinery) into this repo.
        if (excluded.some((e) => f === e || f.startsWith(`${e}/`))) return false;
        if (!include) return true;
        // Only the manifest itself — never .covault/main.git or other state.
        if (f === ".covault/covault.json") return true;
        return include.some((p) => f === p || f.startsWith(`${p}/`));
      },
    });
    const changes: LocalChange[] = [];
    for (const [filepath, head, workdir] of matrix) {
      if (head === 1 && workdir === 1) continue; // unmodified (stage drift alone is not user work)
      if (head === 0 && workdir === 0) continue; // e.g. staged-then-deleted remnant
      changes.push({
        filepath,
        kind: head === 0 ? "added" : workdir === 0 ? "deleted" : "modified",
      });
    }
    // A materialized attachment always differs from its pointer blob, so
    // statusMatrix reports every smudged file as modified forever. It only
    // counts as a change when the *content* no longer matches the pointer.
    const headOid = changes.some((c) => c.kind === "modified" && isLfsPath(c.filepath))
      ? await this.resolve(ref, "HEAD")
      : null;
    const real: LocalChange[] = [];
    for (const change of changes) {
      if (headOid && change.kind === "modified" && isLfsPath(change.filepath)) {
        const pointer = await this.readPointerAt(ref, headOid, change.filepath);
        if (pointer && (await this.workFileSha(ref, change.filepath))?.oid === pointer.oid) continue;
      }
      real.push(change);
    }
    return [...real, ...(await this.trackedUnder(ref, opts.exclude ?? []))];
  }

  /** Tracked files sitting under a now-excluded prefix, as deletions. */
  private async trackedUnder(ref: RepoRef, prefixes: string[]): Promise<LocalChange[]> {
    if (prefixes.length === 0) return [];
    if (!(await this.isRepo(ref))) return []; // nothing tracked yet
    const tracked = await git.listFiles({ fs: this.deps.fs, dir: ref.dir, gitdir: ref.gitdir });
    return tracked
      .filter((f) => prefixes.some((p) => f === p || f.startsWith(`${p}/`)))
      .map((filepath) => ({ filepath, kind: "deleted" as const }));
  }

  /** Commit history touching one file, newest first. */
  async fileLog(ref: RepoRef, filepath: string, depth = 100): Promise<FileCommit[]> {
    const entries = await git.log({
      fs: this.deps.fs,
      dir: ref.dir,
      gitdir: ref.gitdir,
      ref: ref.branch,
      filepath,
      force: true, // don't error when the path is missing in part of the history
      depth,
    });
    return entries.map((e) => ({
      hash: e.oid,
      parents: e.commit.parent,
      message: (e.commit.message ?? "").split("\n")[0] ?? "",
      authorName: e.commit.author.name,
      authorEmail: e.commit.author.email,
      date: new Date(e.commit.author.timestamp * 1000),
    }));
  }

  /** File content at a commit, or null when it doesn't exist there. */
  async readFileAt(ref: RepoRef, oid: string, filepath: string): Promise<string | null> {
    try {
      const { blob } = await git.readBlob({ fs: this.deps.fs, dir: ref.dir, gitdir: ref.gitdir, oid, filepath });
      return new TextDecoder().decode(blob);
    } catch {
      return null;
    }
  }

  readWorkFile(ref: RepoRef, filepath: string): Promise<string> {
    return this.deps.fs.promises.readFile(`${ref.dir}/${filepath}`, "utf8");
  }

  writeWorkFile(ref: RepoRef, filepath: string, content: string): Promise<void> {
    return this.deps.fs.promises.writeFile(`${ref.dir}/${filepath}`, content);
  }

  /**
   * Finish a conflicted merge after the files were resolved (by the agent
   * or the user): stage them, commit with both parents, push.
   */
  async completeMerge(ref: RepoRef, filepaths: string[], message: string): Promise<void> {
    const { fs } = this.deps;
    const done = this.deps.log?.opTime("merge-complete", ref.dir, { files: filepaths.length });
    const local = await this.resolve(ref, `refs/heads/${ref.branch}`);
    const remote = await this.resolve(ref, `refs/remotes/origin/${ref.branch}`);
    if (!local || !remote) throw new Error("Merge state is gone — sync again first.");
    for (const filepath of filepaths) {
      await this.stage(ref, filepath);
    }
    await git.commit({
      fs,
      dir: ref.dir,
      gitdir: ref.gitdir,
      message,
      parent: [local, remote],
      author: this.deps.author(),
    });
    await this.push(ref);
    // A resolved attachment conflict leaves pointer text in the tree.
    await this.smudge(ref);
    done?.();
  }

  /** Throw away an unfinished merge: restore every file to the local
   *  commit (conflict markers vanish; the user's own edits are safe —
   *  they were committed before the merge began). */
  async discardMerge(ref: RepoRef): Promise<void> {
    this.deps.log?.op("merge-discard", ref.dir);
    await git.checkout({ fs: this.deps.fs, dir: ref.dir, gitdir: ref.gitdir, ref: ref.branch, force: true });
    await this.smudge(ref); // the checkout restored pointers over materialized attachments
  }

  /** Stage every change and commit. Returns the new commit oid. */
  async commitAll(ref: RepoRef, message: string, changes: LocalChange[]): Promise<string> {
    const { fs } = this.deps;
    const done = this.deps.log?.opTime("commit", ref.dir, {
      files: changes.length,
      added: changes.filter((c) => c.kind === "added").length,
      deleted: changes.filter((c) => c.kind === "deleted").length,
    });
    for (const change of changes) {
      if (change.kind === "deleted") {
        await git.remove({ fs, dir: ref.dir, gitdir: ref.gitdir, filepath: change.filepath });
      } else {
        await this.stage(ref, change.filepath);
      }
    }
    // The first attachment in a repo brings the LFS rule along for CLI users.
    if (changes.some((c) => c.kind !== "deleted" && isLfsPath(c.filepath)) && (await this.ensureGitattributes(ref))) {
      await git.add({ fs, dir: ref.dir, gitdir: ref.gitdir, filepath: ".gitattributes" });
    }
    const oid = await git.commit({ fs, dir: ref.dir, gitdir: ref.gitdir, message, author: this.deps.author() });
    done?.({ oid: oid.slice(0, 8) });
    return oid;
  }

  private async resolve(ref: RepoRef, gitRef: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: this.deps.fs, dir: ref.dir, gitdir: ref.gitdir, ref: gitRef });
    } catch (e) {
      if (e instanceof git.Errors.NotFoundError) return null;
      throw e;
    }
  }

  async push(ref: RepoRef): Promise<void> {
    // Attachment bytes go first: a pointer must never be visible to a
    // teammate before its content is downloadable.
    await this.uploadLfs(ref);
    const done = this.deps.log?.opTime("push", ref.dir, { branch: ref.branch });
    const result = await git.push({
      ...this.common(ref),
      remote: "origin",
      ref: ref.branch,
    });
    done?.({ ok: result.ok, error: result.error });
    if (!result.ok) throw new Error(`Push to ${ref.url} failed: ${result.error ?? "unknown error"}`);
  }

  /**
   * One full silent sync round for a repo:
   * commit local work → reconcile with the remote → push.
   *
   * Reconcile cases: remote ahead → fast-forward; local ahead → push;
   * diverged → merge (conflict markers stay in the tree on conflict and
   * the round reports them instead of pushing).
   */
  async syncToRemote(
    ref: RepoRef,
    opts: { commitMessage: (changes: LocalChange[]) => string; exclude?: string[]; include?: string[] },
  ): Promise<SyncResult> {
    const result: SyncResult = { committed: [], pulled: false, pushed: false, conflictFilepaths: [] };
    const { fs } = this.deps;

    // Repair pass: an attachment download that failed in an earlier round
    // (or a discarded merge on a closed vault) leaves pointer text on disk;
    // retry it every round rather than only after the next pull.
    await this.smudge(ref);

    const log = this.deps.log;
    const changes = await this.localChanges(ref, { exclude: opts.exclude, include: opts.include });
    log?.log("sync", `${ref.dir} — local scan`, { branch: ref.branch, changes: changes.length });

    // Never commit conflict markers. Files left over from an unresolved
    // merge (or found after a restart wiped the in-memory conflict list)
    // re-enter the conflict pipeline instead of being pushed as "edits".
    // Attachments are exempt: they're binary, and their conflicts never
    // leave markers (see the merge handler below).
    const marked: string[] = [];
    for (const change of changes) {
      if (change.kind === "deleted" || isLfsPath(change.filepath)) continue;
      if (hasConflictMarkers(await this.readWorkFile(ref, change.filepath))) marked.push(change.filepath);
    }
    if (marked.length > 0) {
      result.conflictFilepaths = marked;
      return result;
    }
    if (changes.length > 0) {
      await this.commitAll(ref, opts.commitMessage(changes), changes);
      result.committed = changes;
    }

    const fetched = log?.opTime("fetch", ref.dir, { branch: ref.branch });
    await git.fetch({ ...this.common(ref), remote: "origin", ref: ref.branch, singleBranch: true });
    fetched?.();

    let local = await this.resolve(ref, `refs/heads/${ref.branch}`);
    const remote = await this.resolve(ref, `refs/remotes/origin/${ref.branch}`);
    if (!local) {
      // A clone interrupted between init and checkout leaves a repo with
      // no local branch. It used to fail here on every pass forever; the
      // fetch above has the commits, so finish what was started.
      if (!remote) throw new Error(`Local branch ${ref.branch} missing in ${ref.dir}`);
      log?.op("repair", `${ref.dir} — completing an interrupted clone`, { branch: ref.branch });
      await git.writeRef({ fs, dir: ref.dir, gitdir: ref.gitdir, ref: `refs/heads/${ref.branch}`, value: remote });
      await git.writeRef({
        fs,
        dir: ref.dir,
        gitdir: ref.gitdir,
        ref: "HEAD",
        value: `refs/heads/${ref.branch}`,
        symbolic: true,
        force: true,
      });
      await git.checkout({ fs, dir: ref.dir, gitdir: ref.gitdir, ref: ref.branch, force: true });
      await this.smudge(ref);
      local = remote;
      result.pulled = true;
    }

    if (remote === local) return result; // in step, nothing new either way

    if (!remote || (await git.isDescendent({ fs, dir: ref.dir, gitdir: ref.gitdir, oid: local, ancestor: remote, depth: -1 }))) {
      // Local is strictly ahead (or the remote branch doesn't exist yet).
      await this.push(ref);
      result.pushed = true;
      return result;
    }

    if (await git.isDescendent({ fs, dir: ref.dir, gitdir: ref.gitdir, oid: remote, ancestor: local, depth: -1 })) {
      // Remote is strictly ahead — fast-forward (fetches again internally; cheap, already current).
      const ffDone = this.deps.log?.opTime("fast-forward", ref.dir, { branch: ref.branch });
      await this.dematerialize(ref);
      await git.fastForward({ ...this.common(ref), ref: ref.branch, singleBranch: true });
      ffDone?.();
      await this.smudge(ref);
      result.pulled = true;
      return result;
    }

    // Diverged: merge the remote into the local branch.
    const mergeDone = this.deps.log?.opTime("merge", ref.dir, { branch: ref.branch });
    await this.dematerialize(ref); // the post-merge checkout must see a quiet tree
    try {
      await git.merge({
        fs,
        dir: ref.dir,
        gitdir: ref.gitdir,
        ours: ref.branch,
        theirs: `remotes/origin/${ref.branch}`,
        abortOnConflict: false,
        author: this.deps.author(),
      });
    } catch (e) {
      if (e instanceof git.Errors.MergeConflictError) {
        // Pixels don't merge. A conflicted attachment keeps this device's
        // version (the teammate's stays in history); only notes go on to
        // the AI/manual pipeline. Resolutions are staged now, so the merge
        // commit — whoever completes it — includes them.
        const attachments = e.data.filepaths.filter(isLfsPath);
        const notes = e.data.filepaths.filter((f) => !isLfsPath(f));
        if (attachments.length > 0) {
          const remoteTip = await this.resolve(ref, `refs/remotes/origin/${ref.branch}`);
          for (const filepath of attachments) {
            // Bytes, not text: the blob is usually pointer text, but a
            // pre-LFS raw binary must survive the round trip too.
            const mine = await this.readBlobAt(ref, local, filepath);
            const theirs = remoteTip ? await this.readBlobAt(ref, remoteTip, filepath) : null;
            const keep = mine ?? theirs; // deleted here + changed there → the change wins
            if (keep === null) continue;
            await fs.promises.writeFile(`${ref.dir}/${filepath}`, keep);
            await this.stage(ref, filepath);
          }
          if (notes.length === 0) {
            mergeDone?.({ conflicts: attachments.length, autoResolved: true });
            await this.completeMerge(ref, attachments, `merge: kept this device's attachment(s)`);
            result.pulled = true;
            result.pushed = true;
            return result;
          }
        }
        result.conflictFilepaths = notes;
        mergeDone?.({ conflicts: e.data.filepaths.length, attachments: attachments.length });
        return result;
      }
      throw e;
    }

    // merge() updates the branch ref; materialize the merged tree in the
    // working directory. Non-forced, so an edit that landed mid-sync
    // aborts materialization and is picked up next round.
    await git.checkout({ fs, dir: ref.dir, gitdir: ref.gitdir, ref: ref.branch });
    await this.smudge(ref);
    mergeDone?.({ merged: true });
    result.pulled = true;
    await this.push(ref);
    result.pushed = true;
    return result;
  }
}

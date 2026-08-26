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
  constructor(private deps: GitEngineDeps) {}

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
    return [...changes, ...(await this.trackedUnder(ref, opts.exclude ?? []))];
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
      await git.add({ fs, dir: ref.dir, gitdir: ref.gitdir, filepath });
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
    done?.();
  }

  /** Throw away an unfinished merge: restore every file to the local
   *  commit (conflict markers vanish; the user's own edits are safe —
   *  they were committed before the merge began). */
  async discardMerge(ref: RepoRef): Promise<void> {
    this.deps.log?.op("merge-discard", ref.dir);
    await git.checkout({ fs: this.deps.fs, dir: ref.dir, gitdir: ref.gitdir, ref: ref.branch, force: true });
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
        await git.add({ fs, dir: ref.dir, gitdir: ref.gitdir, filepath: change.filepath });
      }
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

    const log = this.deps.log;
    const changes = await this.localChanges(ref, { exclude: opts.exclude, include: opts.include });
    log?.log("sync", `${ref.dir} — local scan`, { branch: ref.branch, changes: changes.length });

    // Never commit conflict markers. Files left over from an unresolved
    // merge (or found after a restart wiped the in-memory conflict list)
    // re-enter the conflict pipeline instead of being pushed as "edits".
    const marked: string[] = [];
    for (const change of changes) {
      if (change.kind === "deleted") continue;
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
      await git.fastForward({ ...this.common(ref), ref: ref.branch, singleBranch: true });
      ffDone?.();
      result.pulled = true;
      return result;
    }

    // Diverged: merge the remote into the local branch.
    const mergeDone = this.deps.log?.opTime("merge", ref.dir, { branch: ref.branch });
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
        result.conflictFilepaths = e.data.filepaths;
        mergeDone?.({ conflicts: e.data.filepaths.length });
        return result;
      }
      throw e;
    }

    // merge() updates the branch ref; materialize the merged tree in the
    // working directory. Non-forced, so an edit that landed mid-sync
    // aborts materialization and is picked up next round.
    await git.checkout({ fs, dir: ref.dir, gitdir: ref.gitdir, ref: ref.branch });
    mergeDone?.({ merged: true });
    result.pulled = true;
    await this.push(ref);
    result.pushed = true;
    return result;
  }
}

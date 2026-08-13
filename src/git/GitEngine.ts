/**
 * All isomorphic-git access lives here. One engine instance serves every
 * synced repo; each call takes a RepoRef naming the repo it operates on.
 *
 * fs/http are injected: the plugin passes Node's fs (desktop-only) and the
 * requestUrl-based client; tests pass the same fs plus isomorphic-git's
 * node http client against a local git server.
 */
import * as git from "isomorphic-git";
import type { HttpClient } from "isomorphic-git";
import type { TokenProvider } from "../auth/TokenProvider";
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

/** All three git conflict markers at line starts — a note merely *talking*
 *  about git (one marker in a code block) doesn't trip this. */
function hasConflictMarkers(content: string): boolean {
  return /^<<<<<<< /m.test(content) && /^=======$/m.test(content) && /^>>>>>>> /m.test(content);
}

/** Vault paths that must never be committed into a knowledge repo.
 *  (.covault/covault.json is NOT excluded: it must ride along in the
 *  main repo — that's how libraries/marks propagate across machines.
 *  .covault/main.git IS: it's the main repo's own git directory.) */
const ALWAYS_EXCLUDED = [".obsidian", ".trash", ".covault/main.git"];

export class GitEngine {
  constructor(private deps: GitEngineDeps) {}

  private common(ref: RepoRef) {
    const { fs, http } = this.deps;
    return {
      fs,
      http,
      dir: ref.dir,
      gitdir: ref.gitdir,
      onAuth: async () => ({
        username: this.deps.tokens.gitUser(),
        password: await this.deps.tokens.getTokenForOwner(ownerFromUrl(ref.url)),
      }),
      onAuthFailure: () => ({ cancel: true }),
    };
  }

  async clone(ref: RepoRef): Promise<void> {
    await git.clone({
      ...this.common(ref),
      url: ref.url,
      ref: ref.branch,
      singleBranch: true,
    });
  }

  /**
   * Turn an existing folder into a repo and ship it: init on the target
   * branch, point origin at the (empty) remote, commit everything, push.
   * Idempotent enough to retry after a partial failure.
   */
  async initAndPush(ref: RepoRef, message: string): Promise<void> {
    const { fs } = this.deps;
    await git.init({ fs, dir: ref.dir, gitdir: ref.gitdir, defaultBranch: ref.branch });
    await git.addRemote({ fs, dir: ref.dir, gitdir: ref.gitdir, remote: "origin", url: ref.url, force: true });
    const changes = await this.localChanges(ref);
    const hasHead = (await this.resolve(ref, "HEAD")) !== null;
    if (changes.length > 0 || !hasHead) {
      await this.commitAll(ref, message, changes);
    }
    await this.push(ref);
  }

  /**
   * Bind an existing content-bearing folder (typically the vault root) to
   * a remote that may or may not already have history: init, commit local
   * content, and — when the remote has commits — merge them in
   * (allowUnrelatedHistories, since the two sides never shared a base).
   * A same-file conflict throws MergeConflictError for the caller's UI.
   */
  async adoptRemote(
    ref: RepoRef,
    message: string,
    opts: { exclude?: string[]; include?: string[] } = {},
  ): Promise<void> {
    const { fs } = this.deps;
    await git.init({ fs, dir: ref.dir, gitdir: ref.gitdir, defaultBranch: ref.branch });
    await git.addRemote({ fs, dir: ref.dir, gitdir: ref.gitdir, remote: "origin", url: ref.url, force: true });

    const changes = await this.localChanges(ref, opts);
    const hasHead = (await this.resolve(ref, "HEAD")) !== null;
    if (changes.length > 0 || !hasHead) {
      await this.commitAll(ref, message, changes);
    }

    try {
      await git.fetch({ ...this.common(ref), remote: "origin", ref: ref.branch, singleBranch: true });
    } catch {
      /* brand-new empty remote — nothing to fetch */
    }
    const remote = await this.resolve(ref, `refs/remotes/origin/${ref.branch}`);
    const local = await this.resolve(ref, `refs/heads/${ref.branch}`);
    if (remote && local && remote !== local) {
      await git.merge({
        fs,
        dir: ref.dir,
        gitdir: ref.gitdir,
        ours: ref.branch,
        theirs: `remotes/origin/${ref.branch}`,
        abortOnConflict: false,
        allowUnrelatedHistories: true,
        author: this.deps.author(),
      });
      await git.checkout({ fs, dir: ref.dir, gitdir: ref.gitdir, ref: ref.branch });
    }
    await this.push(ref);
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
   * at all — the personal main repo shares nothing by default.
   */
  async localChanges(ref: RepoRef, opts: { exclude?: string[]; include?: string[] } = {}): Promise<LocalChange[]> {
    const excluded = [...ALWAYS_EXCLUDED, ...(opts.exclude ?? [])];
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
    return changes;
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
  }

  /** Throw away an unfinished merge: restore every file to the local
   *  commit (conflict markers vanish; the user's own edits are safe —
   *  they were committed before the merge began). */
  async discardMerge(ref: RepoRef): Promise<void> {
    await git.checkout({ fs: this.deps.fs, dir: ref.dir, gitdir: ref.gitdir, ref: ref.branch, force: true });
  }

  /** Stage every change and commit. Returns the new commit oid. */
  async commitAll(ref: RepoRef, message: string, changes: LocalChange[]): Promise<string> {
    const { fs } = this.deps;
    for (const change of changes) {
      if (change.kind === "deleted") {
        await git.remove({ fs, dir: ref.dir, gitdir: ref.gitdir, filepath: change.filepath });
      } else {
        await git.add({ fs, dir: ref.dir, gitdir: ref.gitdir, filepath: change.filepath });
      }
    }
    return git.commit({ fs, dir: ref.dir, gitdir: ref.gitdir, message, author: this.deps.author() });
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
    const result = await git.push({
      ...this.common(ref),
      remote: "origin",
      ref: ref.branch,
    });
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

    const changes = await this.localChanges(ref, { exclude: opts.exclude, include: opts.include });

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

    await git.fetch({ ...this.common(ref), remote: "origin", ref: ref.branch, singleBranch: true });

    const local = await this.resolve(ref, `refs/heads/${ref.branch}`);
    const remote = await this.resolve(ref, `refs/remotes/origin/${ref.branch}`);
    if (!local) throw new Error(`Local branch ${ref.branch} missing in ${ref.dir}`);

    if (remote === local) return result; // in step, nothing new either way

    if (!remote || (await git.isDescendent({ fs, dir: ref.dir, gitdir: ref.gitdir, oid: local, ancestor: remote, depth: -1 }))) {
      // Local is strictly ahead (or the remote branch doesn't exist yet).
      await this.push(ref);
      result.pushed = true;
      return result;
    }

    if (await git.isDescendent({ fs, dir: ref.dir, gitdir: ref.gitdir, oid: remote, ancestor: local, depth: -1 })) {
      // Remote is strictly ahead — fast-forward (fetches again internally; cheap, already current).
      await git.fastForward({ ...this.common(ref), ref: ref.branch, singleBranch: true });
      result.pulled = true;
      return result;
    }

    // Diverged: merge the remote into the local branch.
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
        return result;
      }
      throw e;
    }

    // merge() updates the branch ref; materialize the merged tree in the
    // working directory. Non-forced, so an edit that landed mid-sync
    // aborts materialization and is picked up next round.
    await git.checkout({ fs, dir: ref.dir, gitdir: ref.gitdir, ref: ref.branch });
    result.pulled = true;
    await this.push(ref);
    result.pushed = true;
    return result;
  }
}

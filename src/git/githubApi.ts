/**
 * Direct GitHub REST helpers (the plugin holds the token, so these hit
 * GitHub without going through the backend). M3/M4 will grow this file
 * with repo-access probes, default-branch resolution, and PR creation —
 * agentic-git-sync's githubApi.ts is the reference implementation.
 */
import { requestUrl, type RequestUrlResponse } from "obsidian";

const UA = { "User-Agent": "Covault" };

/**
 * Grant a user access to a repo (`PUT /repos/{owner}/{repo}/collaborators/
 * {username}`). Needed after app-created repos: the creator is the App,
 * so the human owner must be added explicitly.
 */
export async function addCollaborator(
  token: string,
  owner: string,
  repo: string,
  username: string,
  permission: "pull" | "push" | "admin",
): Promise<void> {
  const res = await requestUrl({
    url: `https://api.github.com/repos/${owner}/${repo}/collaborators/${username}`,
    method: "PUT",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...UA,
    },
    body: JSON.stringify({ permission }),
    throw: false,
  });
  // 201 = invitation created, 204 = already a collaborator/updated.
  if (res.status !== 201 && res.status !== 204) {
    const msg = (res.json as { message?: string } | null)?.message;
    throw new Error(`Couldn't grant ${username} access (HTTP ${res.status}${msg ? `: ${msg}` : ""}).`);
  }
}

export interface CreatedRepo {
  fullName: string;
  /** HTTPS clone URL. */
  url: string;
}

/** Whether `owner/repo` exists and is visible to this token. Use a
 *  repo-creation (un-narrowed) token: narrowed tokens 404 on every repo
 *  outside their allowlist, so existence probes with them are meaningless. */
export async function repoExists(token: string, owner: string, repo: string): Promise<boolean> {
  const res = await requestUrl({
    url: `https://api.github.com/repos/${owner}/${repo}`,
    headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json", ...UA },
    throw: false,
  });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  const msg = (res.json as { message?: string } | null)?.message;
  throw new Error(`Couldn't check ${owner}/${repo} (HTTP ${res.status}${msg ? `: ${msg}` : ""}).`);
}

/** The repo name is taken — callers offer "connect to it instead". */
export class RepoExistsError extends Error {
  constructor(
    public org: string,
    public repoName: string,
  ) {
    super(`A repository named "${repoName}" already exists in ${org}.`);
    this.name = "RepoExistsError";
  }
}

/**
 * Create a repository under an org (`POST /orgs/{org}/repos`). Requires
 * the installation to have Administration: write. `auto_init` stays off —
 * the plugin pushes the folder's own initial commit right after.
 */
export async function createOrgRepo(
  token: string,
  org: string,
  name: string,
  isPrivate: boolean,
): Promise<CreatedRepo> {
  const res = await requestUrl({
    url: `https://api.github.com/orgs/${org}/repos`,
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...UA,
    },
    body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
    throw: false,
  });
  if (res.status === 201) {
    const body = res.json as { full_name?: string; clone_url?: string };
    if (body.full_name && body.clone_url) return { fullName: body.full_name, url: body.clone_url };
    throw new Error("GitHub created the repository but returned an unexpected response.");
  }
  if (res.status === 422) {
    const detail = (res.json as { errors?: { message?: string }[]; message?: string } | null) ?? {};
    const msg = detail.errors?.[0]?.message ?? detail.message ?? "";
    if (/already exists/i.test(msg)) throw new RepoExistsError(org, name);
    throw new Error(`GitHub rejected the repository name "${name}"${msg ? ` — ${msg}` : ""}.`);
  }
  if (res.status === 403 || res.status === 404) {
    throw new Error(
      `Not allowed to create repositories in ${org} — the Covault app needs ` +
        `"Administration: Read and write" permission and must be installed on that organization.`,
    );
  }
  const msg = (res.json as { message?: string } | null)?.message;
  throw new Error(`Couldn't create the repository (HTTP ${res.status}${msg ? `: ${msg}` : ""}).`);
}

/**
 * List the repositories an installation token can access
 * (`GET /installation/repositories`, paginated). Populates the repo
 * picker. Returns full names ("owner/repo"). Best-effort: stops on the
 * first non-200 and returns whatever it gathered.
 */
export async function listInstallationRepos(token: string): Promise<string[]> {
  if (!token) return [];
  const names: string[] = [];
  for (let page = 1; page <= 20; page++) {
    let res: RequestUrlResponse;
    try {
      res = await requestUrl({
        url: `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
        headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json", ...UA },
        throw: false,
      });
    } catch {
      break;
    }
    if (res.status !== 200) break;
    const body = res.json as { repositories?: { full_name?: string }[] } | null;
    const repos = body?.repositories ?? [];
    for (const r of repos) if (r.full_name) names.push(r.full_name);
    if (repos.length < 100) break;
  }
  return names;
}

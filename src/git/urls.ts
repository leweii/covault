/** Helpers for HTTPS git remote URLs (the only transport we support). */

/** Owner (org or user) segment, e.g. "chancetop" for github.com/chancetop/platform-kb. */
export function ownerFromUrl(url: string): string {
  const owner = new URL(url).pathname.split("/").filter(Boolean)[0];
  if (!owner) throw new Error(`Can't derive an owner from remote URL: ${url}`);
  return owner;
}

/** Repository name without the trailing ".git". */
export function repoNameFromUrl(url: string): string {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) throw new Error(`Can't derive a repo name from remote URL: ${url}`);
  return last.replace(/\.git$/, "");
}

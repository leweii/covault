/**
 * The Time Machine's list of versions, assembled from a file's commit
 * log plus the state of the file on disk. Pure, so the rules are tested:
 *  - a shallow clone's boundary commit is not a version (git lists it for
 *    every file whether or not the file changed there);
 *  - an edit on this device that no sync has saved yet is a version too,
 *    the newest, so the list never hides what the user is looking at;
 *  - the current user is "You".
 */
import type { FileCommit } from "../git/GitEngine";

export interface Version {
  /** Commit hash, or "local" for the unsaved edit on this device. */
  key: string;
  message: string;
  author: string;
  authorEmail: string;
  /** ms */
  at: number;
  local: boolean;
}

export const LOCAL_KEY = "local";

export function assembleVersions(
  log: FileCommit[],
  workText: string | null,
  headText: string | null,
  meEmail: string,
  now = Date.now(),
): Version[] {
  const me = meEmail.toLowerCase();
  const versions: Version[] = log
    .filter((c) => !c.shallowBoundary)
    .map((c) => ({
      key: c.hash,
      message: c.message || "(no message)",
      author: c.authorEmail.toLowerCase() === me ? "You" : c.authorName,
      authorEmail: c.authorEmail,
      at: c.date.getTime(),
      local: false,
    }));
  if (workText !== null && workText !== (headText ?? "")) {
    versions.unshift({
      key: LOCAL_KEY,
      message: "Not shared yet — edited on this device",
      author: "You",
      authorEmail: meEmail,
      at: now,
      local: true,
    });
  }
  return versions;
}

/** "Today", "Yesterday", "October 14" (with the year when it isn't this one). */
export function dayLabel(at: number, now = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString([], d.getFullYear() === today.getFullYear() ? { month: "long", day: "numeric" } : { year: "numeric", month: "long", day: "numeric" });
}

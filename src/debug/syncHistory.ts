/**
 * Sync history: one entry per successful sync round, in its own file next
 * to the operations log (per device, outside the vault — see logger.ts for
 * why). The operations log interleaves every git step and rotates at 2 MB;
 * this file answers one question at a glance — "when did each library
 * last sync, and what did it carry?" — which is what a user (or whoever
 * helps them) checks first when syncing seems to have stopped.
 *
 *   2026-10-22 16:40:12  team-cookbook-kb  auto  saved 1 change(s), got teammates' updates, shared yours  (4.2s)
 *     ↑ M notes/plan.md
 *     ↓ A notes/new idea.md   (Brooker Fang)
 *
 * ↑ is what this device shared, ↓ what teammates' changes brought in.
 */
import type { IncomingChanges, LocalChange } from "../git/GitEngine";

export interface SyncRecord {
  at: number;
  library: string;
  trigger: "manual" | "auto";
  /** Human summary of the round, e.g. "got teammates' updates". */
  summary: string;
  /** Local changes the round committed and shared. */
  files: LocalChange[];
  /** Teammates' changes the round pulled in. */
  incoming?: IncomingChanges | null;
  ms: number;
}

export interface SyncHistoryDeps {
  fs: typeof import("fs");
  /** Absolute path of the directory the file lives in. */
  logDir: () => string;
}

const FILE_NAME = "sync-history.log";
/** Rotate at 1 MB, keeping one generation back. */
const MAX_FILE_BYTES = 1024 * 1024;
/** Past this many files a round lists the count, not every path. */
const MAX_FILES_LISTED = 20;
const KIND_MARK: Record<LocalChange["kind"], string> = { added: "A", modified: "M", deleted: "D" };

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function listFiles(lines: string[], arrow: string, files: LocalChange[], suffix = ""): void {
  files.slice(0, MAX_FILES_LISTED).forEach((f, i) =>
    lines.push(`    ${arrow} ${KIND_MARK[f.kind]} ${f.filepath}${i === 0 ? suffix : ""}`),
  );
  if (files.length > MAX_FILES_LISTED) lines.push(`    ${arrow} … and ${files.length - MAX_FILES_LISTED} more`);
}

export function formatSyncRecord(r: SyncRecord): string {
  const lines = [`${stamp(r.at)}  ${r.library}  ${r.trigger}  ${r.summary}  (${(r.ms / 1000).toFixed(1)}s)`];
  listFiles(lines, "↑", r.files);
  const incoming = r.incoming;
  if (incoming) listFiles(lines, "↓", incoming.files, incoming.authors.length ? `   (${incoming.authors.join(", ")})` : "");
  return lines.join("\n");
}

export class SyncHistory {
  /** One failed write disables the file; syncing never depends on it. */
  private broken = false;

  constructor(private deps: SyncHistoryDeps) {}

  filePath(): string {
    return `${this.deps.logDir()}/${FILE_NAME}`;
  }

  append(record: SyncRecord): void {
    if (this.broken) return;
    const { fs } = this.deps;
    try {
      fs.mkdirSync(this.deps.logDir(), { recursive: true });
      const file = this.filePath();
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size > MAX_FILE_BYTES) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${formatSyncRecord(record)}\n`, "utf8");
    } catch (e) {
      this.broken = true;
      console.warn("[covault] sync history file unavailable:", e);
    }
  }

  /** The newest `maxLines` lines, oldest first — for the history dialog. */
  tail(maxLines = 300): string {
    try {
      const text = this.deps.fs.readFileSync(this.filePath(), "utf8");
      return text.trimEnd().split("\n").slice(-maxLines).join("\n");
    } catch {
      return "";
    }
  }
}

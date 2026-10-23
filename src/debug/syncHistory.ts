/**
 * Sync history: one record per sync round, kept two ways next to the
 * operations log (per device, outside the vault — see logger.ts for why):
 *
 *   sync-history.log    readable text, newest last, rotated at 1 MB
 *   sync-history.jsonl  the same records as JSON, newest 500, for the workbench
 *
 * The operations log interleaves every git step; this answers the first
 * question anyone asks when syncing seems to have stopped: when did each
 * library last sync, what did it carry, and did it fail?
 *
 *   2026-10-22 16:40:12  team-cookbook-kb  auto  saved 1 change(s), got teammates' updates  (4.2s)
 *     ↑ M notes/plan.md
 *     ↓ A notes/new idea.md   (Brooker Fang)
 *   2026-10-22 16:50:12  team-ccp-kb  auto  FAILED  couldn't reach GitHub  (30.0s)
 *
 * ↑ is what this device shared, ↓ what teammates' changes brought in.
 */
import type { IncomingChanges, LocalChange } from "../git/GitEngine";

export type SyncStatus = "ok" | "error" | "conflict";

export interface SyncRecord {
  at: number;
  /** Display label of the library ("Personal knowledge base" for the root). */
  library: string;
  /** SyncItem path ("" = personal knowledge base) — the stable key the
   *  workbench joins records to repos by. Absent on records older than it. */
  repoPath?: string;
  trigger: "manual" | "auto";
  status: SyncStatus;
  /** Human summary of the round, e.g. "got teammates' updates". */
  summary: string;
  /** Why it failed, when status is "error". */
  error?: string;
  /** Local changes the round committed and shared. */
  files: LocalChange[];
  /** Teammates' changes the round pulled in. */
  incoming?: IncomingChanges | null;
  ms: number;
}

export interface SyncHistoryDeps {
  fs: typeof import("fs");
  /** Absolute path of the directory the files live in. */
  logDir: () => string;
}

const TEXT_FILE = "sync-history.log";
const JSON_FILE = "sync-history.jsonl";
/** Rotate the text file at 1 MB, keeping one generation back. */
const MAX_TEXT_BYTES = 1024 * 1024;
/** Records kept in the JSON file; older ones fall off. */
const MAX_RECORDS = 500;
/** Past this many files a round lists the count, not every path. */
const MAX_FILES_LISTED = 20;
const KIND_MARK: Record<LocalChange["kind"], string> = { added: "A", modified: "M", deleted: "D" };
const STATUS_TAG: Record<SyncStatus, string> = { ok: "", error: "FAILED  ", conflict: "NEEDS INPUT  " };

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function listFiles(lines: string[], arrow: string, files: (LocalChange & { author?: string })[], suffix = ""): void {
  files.slice(0, MAX_FILES_LISTED).forEach((f, i) => {
    const who = f.author ? `   (${f.author})` : i === 0 ? suffix : "";
    lines.push(`    ${arrow} ${KIND_MARK[f.kind]} ${f.filepath}${who}`);
  });
  if (files.length > MAX_FILES_LISTED) lines.push(`    ${arrow} … and ${files.length - MAX_FILES_LISTED} more`);
}

export function formatSyncRecord(r: SyncRecord): string {
  const lines = [
    `${stamp(r.at)}  ${r.library}  ${r.trigger}  ${STATUS_TAG[r.status]}${r.summary}  (${(r.ms / 1000).toFixed(1)}s)`,
  ];
  listFiles(lines, "↑", r.files);
  const incoming = r.incoming;
  if (incoming) {
    // Per-file credit when the engine knows it; the round's author list
    // on the first line otherwise (records from before per-file credit).
    const perFile = incoming.files.some((f) => f.author);
    listFiles(lines, "↓", incoming.files, !perFile && incoming.authors.length ? `   (${incoming.authors.join(", ")})` : "");
  }
  return lines.join("\n");
}

export class SyncHistory {
  /** One failed write disables the files; syncing never depends on them. */
  private broken = false;
  /** JSON records, newest first; loaded on first use. */
  private cache: SyncRecord[] | null = null;

  constructor(private deps: SyncHistoryDeps) {}

  filePath(): string {
    return `${this.deps.logDir()}/${TEXT_FILE}`;
  }

  jsonPath(): string {
    return `${this.deps.logDir()}/${JSON_FILE}`;
  }

  append(record: SyncRecord): void {
    const records = this.records();
    records.unshift(record);
    if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
    if (this.broken) return;
    const { fs } = this.deps;
    try {
      fs.mkdirSync(this.deps.logDir(), { recursive: true });
      const file = this.filePath();
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size > MAX_TEXT_BYTES) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${formatSyncRecord(record)}\n`, "utf8");
      // Oldest first on disk, so the file reads like the text log.
      fs.writeFileSync(this.jsonPath(), `${[...records].reverse().map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
    } catch (e) {
      this.broken = true;
      console.warn("[covault] sync history files unavailable:", e);
    }
  }

  /** Structured records, newest first. */
  records(limit = MAX_RECORDS): SyncRecord[] {
    if (!this.cache) {
      this.cache = [];
      try {
        const lines = this.deps.fs.readFileSync(this.jsonPath(), "utf8").split("\n").filter(Boolean);
        for (const line of lines.reverse()) {
          try {
            const r = JSON.parse(line) as SyncRecord;
            if (r && typeof r.at === "number") this.cache.push(r);
          } catch {
            /* a torn line from a crash mid-write — skip it */
          }
        }
      } catch {
        /* nothing recorded yet */
      }
    }
    return limit >= this.cache.length ? this.cache : this.cache.slice(0, limit);
  }

  /** The newest `maxLines` text lines, oldest first. */
  tail(maxLines = 300): string {
    try {
      const text = this.deps.fs.readFileSync(this.filePath(), "utf8");
      return text.trimEnd().split("\n").slice(-maxLines).join("\n");
    } catch {
      return "";
    }
  }
}

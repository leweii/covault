/**
 * The plugin's operations log.
 *
 * Two levels. OPERATIONS — every git action the plugin performs (clone,
 * fetch, push, commit, merge, adopt…) — are ALWAYS recorded: this plugin
 * silently rewrites the user's notes over git, and an unconditional
 * journal of what it did is part of the trust contract (and the undo
 * story: the log says what happened, git history holds the content).
 * VERBOSE — network-level detail like request byte counts — is gated on
 * the debug-mode setting, for chasing a specific failure.
 *
 * Two sinks: an in-memory ring (for "copy the log" right after a failure)
 * and an append-only file in the per-device config directory, which
 * survives the restart a stuck sync usually invites. Deliberately not
 * inside the vault: a synced vault hands one log file to several machines,
 * which all append to it.
 *
 * Everything written here is meant to be pasted into a bug report, so
 * every value passes through redact() first — git traffic carries tokens
 * in headers and can carry them in URLs.
 */

export interface DebugLogEntry {
  at: number;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface DebugLogDeps {
  fs: typeof import("fs");
  /** Live read — the user can flip debug mode mid-session. */
  enabled: () => boolean;
  /** Absolute path of the directory the log file lives in. */
  logDir: () => string;
}

/** Keep the tail of a long session without unbounded growth. */
const MAX_ENTRIES = 2_000;
/** Rotate at 2 MB: one generation back is plenty for a bug report. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const FILE_NAME = "covault.log";

/** Key names whose values are secrets wherever they appear. */
const SECRET_KEY = /^(authorization|auth|token|password|secret|cookie|set-cookie|sessionid|session_id)$/i;
/** Anything shaped like a GitHub token, wherever it ended up. */
const TOKEN_LIKE = /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const MAX_STRING = 300;

/** Strip credentials from a URL's userinfo — `https://x:tok@host/r.git`
 *  is how isomorphic-git carries a PAT when one is embedded. */
function redactUrl(value: string): string {
  return value.replace(/\/\/[^/@\s]+@/, "//<redacted>@");
}

function redactString(value: string): string {
  const clean = redactUrl(value).replace(TOKEN_LIKE, "<redacted>");
  return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}… (${clean.length} chars)` : clean;
}

/**
 * Deep-redact a value for logging: secret-named keys are dropped to a
 * marker, strings are scrubbed and truncated, and depth/breadth are
 * capped so a stray git object can't dump the repo into the log.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (depth >= 3) return "…";
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((v) => redact(v, depth + 1));
    return value.length > 20 ? [...head, `… ${value.length - 20} more`] : head;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "<redacted>" : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function stamp(at: number): string {
  return new Date(at).toISOString().replace("T", " ").replace("Z", "");
}

export function formatEntry(entry: DebugLogEntry): string {
  const head = `${stamp(entry.at)} [${entry.scope}] ${entry.message}`;
  if (!entry.data || Object.keys(entry.data).length === 0) return head;
  return `${head} ${JSON.stringify(entry.data)}`;
}

export class DebugLog {
  private entries: DebugLogEntry[] = [];
  /** One failed write disables the file sink; the ring keeps working. */
  private fileBroken = false;

  constructor(private deps: DebugLogDeps) {}

  isEnabled(): boolean {
    return this.deps.enabled();
  }

  filePath(): string {
    return `${this.deps.logDir()}/${FILE_NAME}`;
  }

  /** OPERATIONS level: always recorded, regardless of debug mode. */
  op(scope: string, message: string, data?: Record<string, unknown>): void {
    this.write(scope, message, data);
  }

  /** Time an operation (always recorded). */
  opTime(scope: string, message: string, data?: Record<string, unknown>): (extra?: Record<string, unknown>) => void {
    const startedAt = Date.now();
    this.write(scope, `${message} — started`, data);
    return (extra?: Record<string, unknown>) => {
      this.write(scope, `${message} — done`, { ...extra, ms: Date.now() - startedAt });
    };
  }

  /** VERBOSE level: recorded only while debug mode is on. */
  log(scope: string, message: string, data?: Record<string, unknown>): void {
    if (!this.isEnabled()) return;
    this.write(scope, message, data);
  }

  private write(scope: string, message: string, data?: Record<string, unknown>): void {
    const entry: DebugLogEntry = {
      at: Date.now(),
      scope,
      // Messages get the same scrub as data: error texts embed URLs, and
      // URLs can embed credentials.
      message: redact(message) as string,
      data: data ? (redact(data) as Record<string, unknown>) : undefined,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.append(entry);
  }

  /**
   * Time an operation: returns a finisher that logs the elapsed ms.
   * Safe to call when disabled — the finisher is then a no-op.
   */
  time(scope: string, message: string, data?: Record<string, unknown>): (extra?: Record<string, unknown>) => void {
    if (!this.isEnabled()) return () => {};
    const startedAt = Date.now();
    this.log(scope, `${message} — started`, data);
    return (extra?: Record<string, unknown>) => {
      this.log(scope, `${message} — done`, { ...extra, ms: Date.now() - startedAt });
    };
  }

  /** Newest last — what the "copy log" command hands the user. */
  snapshot(): DebugLogEntry[] {
    return [...this.entries];
  }

  format(): string {
    return this.entries.map(formatEntry).join("\n");
  }

  clear(): void {
    this.entries = [];
    try {
      this.deps.fs.rmSync(this.filePath(), { force: true });
      this.fileBroken = false;
    } catch {
      // Nothing to clear, or the file is locked — the ring is cleared
      // either way, which is what the user asked for.
    }
  }

  private append(entry: DebugLogEntry): void {
    if (this.fileBroken) return;
    const { fs } = this.deps;
    try {
      const dir = this.deps.logDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = this.filePath();
      // Rotate before writing so the current generation stays whole.
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size > MAX_FILE_BYTES) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${formatEntry(entry)}\n`, "utf8");
    } catch (e) {
      this.fileBroken = true;
      console.warn("[covault] debug log file unavailable, keeping in-memory only:", e);
    }
  }
}

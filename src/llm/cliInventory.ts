/**
 * What the agent can actually run.
 *
 * run_command gives Ask a shell, but a shell is useless if the model
 * doesn't know what's in it: asked to analyse warehouse data it answers
 * "I have no access" while `bq` sits on the PATH. So before every
 * conversation we probe the machine for known CLIs and hand the agent the
 * list — with a one-line hint per tool on when to reach for it.
 *
 * The probe also fixes the reason those tools are often unreachable:
 * a GUI app launched from Finder/Dock inherits a bare PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), so homebrew, gcloud and friends are
 * invisible to child processes. We resolve the user's login-shell PATH
 * once and use that same env for detection *and* for run_command, so the
 * manifest never advertises a tool the agent then fails to run.
 *
 * Nothing here is a permission: the approval gate in agentTools.ts still
 * confirms every command. This only decides what the model knows exists.
 */
import { exec } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** A CLI worth telling the model about, and what it's good for. */
interface CliCandidate {
  name: string;
  hint: string;
  /**
   * Optional: a cheap, local, read-only command whose output tells the
   * model which account/project/cluster this CLI is pointed at. Knowing
   * "bq exists" is not enough — the first real question failed because
   * the agent hit a 403 on the default project and read it as "no
   * access" rather than "wrong project". Must not touch the network.
   */
  context?: string;
}

/**
 * The probe list. Presence is checked with `command -v`, so entries cost
 * nothing when absent — bias towards including anything a knowledge
 * worker's question might need. The hint is what the model reads, so it
 * describes *when to reach for the tool*, not what the tool is.
 */
const CANDIDATES: CliCandidate[] = [
  // Data & warehouses — the ones questions about "the data" usually mean.
  {
    name: "bq",
    hint:
      "query BigQuery: `bq query --use_legacy_sql=false 'SELECT …'`, `bq ls project:dataset` to explore. " +
      "The query is billed to the default project, which is often NOT the project that owns the table — on " +
      "\"does not have bigquery.jobs.create permission in project X\", retry billing it to the table's own " +
      "project: `bq --project_id=<project-from-the-table-name> query …`. Use --dry_run first on anything large",
    context: "gcloud config list --format='value[separator=\" · default project \"](core.account,core.project)'",
  },
  { name: "gcloud", hint: "Google Cloud: projects, auth, logs. `--project=<id>` overrides the default per command" },
  { name: "gsutil", hint: "read/write Google Cloud Storage buckets" },
  {
    name: "aws",
    hint: "AWS: S3, Athena, Redshift, logs (`aws sts get-caller-identity` confirms who you are)",
    context: "aws configure list 2>/dev/null | tr -s ' ' | cut -d: -f1,2 | grep -E '^(profile|region)'",
  },
  { name: "az", hint: "Azure resources and data services" },
  { name: "snowsql", hint: "query Snowflake" },
  { name: "psql", hint: "query PostgreSQL" },
  { name: "mysql", hint: "query MySQL/MariaDB" },
  { name: "sqlite3", hint: "query a .sqlite/.db file" },
  { name: "duckdb", hint: "SQL over local CSV/Parquet files: `duckdb -c \"SELECT * FROM 'f.csv'\"`" },
  { name: "clickhouse-client", hint: "query ClickHouse" },
  { name: "mongosh", hint: "query MongoDB" },
  { name: "redis-cli", hint: "inspect Redis keys" },
  { name: "dbt", hint: "inspect/run dbt models in a data project" },
  { name: "trino", hint: "query Trino/Presto" },
  // Text wrangling — how tool output becomes an answer.
  { name: "jq", hint: "slice JSON output from any other command" },
  { name: "yq", hint: "read YAML/TOML the way jq reads JSON" },
  { name: "rg", hint: "fast recursive search (ripgrep), faster than grep on large trees" },
  { name: "fd", hint: "fast file finding by name" },
  { name: "csvkit", hint: "CSV toolkit: csvlook, csvstat, csvsql" },
  { name: "xsv", hint: "fast CSV stats, slicing and joins" },
  // Runtimes — for a computation no CLI does directly.
  { name: "python3", hint: "arithmetic, stats, pandas, parsing — write a short script for anything fiddly" },
  { name: "uv", hint: "run Python with deps on the fly: `uv run --with pandas script.py`" },
  { name: "node", hint: "JavaScript one-liners: `node -e '…'`" },
  { name: "Rscript", hint: "R for statistics" },
  // Repos, tickets, services.
  { name: "git", hint: "history of this vault or any repo: who changed a note, when, why" },
  { name: "gh", hint: "GitHub: PRs, issues, code search, `gh api` for anything else" },
  { name: "glab", hint: "GitLab: MRs and issues" },
  { name: "curl", hint: "call an HTTP API directly" },
  { name: "kubectl", hint: "Kubernetes: pods, logs, config", context: "kubectl config current-context" },
  { name: "docker", hint: "containers and images" },
  { name: "terraform", hint: "read infrastructure state and plans" },
  // Documents and media.
  { name: "pandoc", hint: "convert between markdown, docx, pdf, html" },
  { name: "pdftotext", hint: "extract text from a PDF so it can be read/searched" },
  { name: "ffmpeg", hint: "audio/video conversion, extract audio for transcription" },
  { name: "magick", hint: "image conversion and inspection (ImageMagick)" },
  { name: "tesseract", hint: "OCR an image or scanned page" },
  // Other agents, when a task is better delegated.
  { name: "claude", hint: "Claude Code CLI — delegate a coding task in a repo" },
  { name: "codex", hint: "Codex CLI — delegate a coding task in a repo" },
  { name: "ollama", hint: "local models, for bulk text work that shouldn't leave the machine" },
];

/** A tool name we're willing to interpolate into the probe script. */
const SAFE_NAME = /^[a-zA-Z0-9_.+-]+$/;

/** Directories a GUI-launched app misses but user CLIs usually live in. */
function extraPathDirs(home: string): string[] {
  return [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    path.join(home, ".local/bin"),
    path.join(home, "bin"),
    path.join(home, ".cargo/bin"),
    path.join(home, "go/bin"),
    path.join(home, "google-cloud-sdk/bin"),
    "/usr/local/share/google-cloud-sdk/bin",
    "/opt/homebrew/share/google-cloud-sdk/bin",
    path.join(home, "miniconda3/bin"),
    path.join(home, "anaconda3/bin"),
  ];
}

/** The side of this module that touches the machine — faked in tests. */
export interface CliProbeHost {
  platform: string;
  /** The user's login shell, if the OS reports one. */
  shell?: string;
  /** Environment to start from (normally process.env). */
  baseEnv: Record<string, string | undefined>;
  homedir: string;
  dirExists: (dir: string) => boolean;
  /** Run a shell snippet and resolve whatever it printed. Never rejects,
   *  and never discards stdout on a non-zero exit: the probe's own last
   *  `command -v` miss makes the script exit non-zero while its earlier
   *  hits are perfectly good. */
  sh: (command: string, env: Record<string, string | undefined>, timeoutMs: number) => Promise<string>;
}

const PATH_TIMEOUT_MS = 4_000;
const PROBE_TIMEOUT_MS = 10_000;
const CONTEXT_TIMEOUT_MS = 6_000;
/** A context line is orientation, not data — keep it short. */
const MAX_CONTEXT_CHARS = 200;

export const defaultProbeHost: CliProbeHost = {
  platform: process.platform,
  shell: process.env.SHELL,
  baseEnv: process.env,
  homedir: os.homedir(),
  dirExists: (dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  },
  sh: (command, env, timeoutMs) =>
    new Promise((resolve) => {
      exec(command, { env: env as NodeJS.ProcessEnv, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (_error, stdout) =>
        resolve(stdout ?? ""),
      );
    }),
};

/**
 * The PATH the user would have in a terminal, not the one Finder handed
 * Obsidian. Asks the login shell (interactive too — plenty of people set
 * PATH in .zshrc), then unions in the usual install dirs that exist, so a
 * shell we couldn't read still gets us most of the way.
 */
export async function resolveShellPath(host: CliProbeHost): Promise<string> {
  const dirs: string[] = [];
  const add = (value: string) => {
    for (const dir of value.split(path.delimiter)) {
      const trimmed = dir.trim();
      if (trimmed && !dirs.includes(trimmed)) dirs.push(trimmed);
    }
  };

  if (host.shell && host.platform !== "win32") {
    // printf, not echo: the PATH lands as the tail of stdout even if an
    // interactive rc file chatters first.
    const out = await host.sh(
      `${host.shell} -lic 'printf "\\nCOVAULT_PATH=%s" "$PATH"' 2>/dev/null`,
      host.baseEnv,
      PATH_TIMEOUT_MS,
    );
    const marked = out.split("COVAULT_PATH=").pop() ?? "";
    if (marked.includes(path.delimiter) || marked.includes("/")) add(marked.trim());
  }
  add(host.baseEnv.PATH ?? "");
  for (const dir of extraPathDirs(host.homedir)) {
    if (host.dirExists(dir)) add(dir);
  }
  return dirs.join(path.delimiter);
}

/** Which of the candidates exist on this machine, in candidate order. */
export async function detectClis(
  host: CliProbeHost,
  env: Record<string, string | undefined>,
  candidates: CliCandidate[] = CANDIDATES,
): Promise<string[]> {
  const names = candidates.map((c) => c.name).filter((n) => SAFE_NAME.test(n));
  if (names.length === 0) return [];
  const script = `for n in ${names.join(" ")}; do command -v "$n" >/dev/null 2>&1 && echo "$n"; done; exit 0`;
  const out = await host.sh(script, env, PROBE_TIMEOUT_MS);
  const found = new Set(out.split("\n").map((l) => l.trim()));
  return names.filter((n) => found.has(n));
}

/**
 * For the detected tools that have one, what they are pointed at right
 * now (active gcloud project, AWS profile, kube context). Run in
 * parallel; a probe that fails or hangs simply contributes nothing.
 */
export async function detectCliContext(
  host: CliProbeHost,
  env: Record<string, string | undefined>,
  found: string[],
  candidates: CliCandidate[] = CANDIDATES,
): Promise<Record<string, string>> {
  const withContext = candidates.filter((c) => c.context && found.includes(c.name));
  const results = await Promise.all(
    withContext.map(async (c) => {
      const out = await host.sh(`${c.context}; exit 0`, env, CONTEXT_TIMEOUT_MS);
      const text = out
        .split("\n")
        .map((l) => l.replace(/[\t ]+/g, " ").trim())
        .filter(Boolean)
        .join(" · ")
        .slice(0, MAX_CONTEXT_CHARS);
      return [c.name, text] as const;
    }),
  );
  return Object.fromEntries(results.filter(([, text]) => text));
}

/** The block that goes into the system prompt. Null when there is nothing
 *  worth saying — no detected tool and no user-declared one. */
export function renderCliManifest(input: {
  platform: string;
  cwd: string;
  found: string[];
  /** name → what that CLI is currently pointed at. */
  context?: Record<string, string>;
  declared?: string;
  candidates?: CliCandidate[];
}): string | null {
  const candidates = input.candidates ?? CANDIDATES;
  const hints = new Map(candidates.map((c) => [c.name, c.hint]));
  const declared = (input.declared ?? "").trim();
  if (input.found.length === 0 && !declared) return null;

  const lines = [
    "=== Command-line tools available to you ===",
    `run_command runs in the vault folder (${input.cwd}) on ${input.platform}, with the user's own PATH, ` +
      "credentials and configs — so anything they can run in a terminal, you can run here.",
  ];
  if (input.found.length > 0) {
    lines.push("", "Detected on this machine:");
    for (const name of input.found) {
      lines.push(`- ${name} — ${hints.get(name) ?? "available on the PATH"}`);
      const context = input.context?.[name];
      if (context) lines.push(`  currently configured as: ${context}`);
    }
  }
  if (declared) {
    lines.push("", "The user also told you about these:", declared);
  }
  lines.push(
    "",
    "Use them when the notes can't answer alone — live data, repo history, ticket state, file conversion. " +
      "Prefer a read-only command first (list, describe, --dry-run) and check the configured context above " +
      "before trusting results. This list isn't exhaustive: for anything else, `command -v <name>` tells you " +
      "whether it's there. Every command is shown to the user for approval, so state plainly what you're " +
      "about to run and why.",
    "A permissions or 'not found' error on the *default* project/profile/context is a configuration mismatch, " +
      "not a wall — the default is rarely the one that owns the data you were asked about. Point the command " +
      "at the right one and try again (bq --project_id=…, gcloud --project=…, aws --profile=…, kubectl " +
      "--context=…) before reporting that you have no access. Only after a targeted retry also fails is " +
      "\"no access\" the honest answer — and then say which account and project you tried.",
  );
  return lines.join("\n");
}

interface ProbeResult {
  env: Record<string, string | undefined>;
  found: string[];
  context: Record<string, string>;
}

export interface CliInventoryDeps {
  /** Vault folder — where run_command runs. */
  cwd: () => string;
  /** User-declared extras from settings (free text, may be empty). */
  declared: () => string;
  host?: CliProbeHost;
}

/**
 * Probes once and caches: the answer barely changes within a session, and
 * a conversation shouldn't pay for it twice. The cached env is what
 * run_command executes with, so detection and execution can't disagree.
 */
export class CliInventory {
  private host: CliProbeHost;
  private pending: Promise<ProbeResult> | null = null;
  private resolved: ProbeResult | null = null;

  constructor(private deps: CliInventoryDeps) {
    this.host = deps.host ?? defaultProbeHost;
  }

  /** Forget the probe; the next manifest() looks again (new tool installed). */
  refresh(): void {
    this.pending = null;
    this.resolved = null;
  }

  private probe(): Promise<ProbeResult> {
    if (!this.pending) {
      this.pending = (async () => {
        const env = { ...this.host.baseEnv, PATH: await resolveShellPath(this.host) };
        const found = await detectClis(this.host, env);
        const context = await detectCliContext(this.host, env, found);
        this.resolved = { env, found, context };
        return this.resolved;
      })().catch((e) => {
        // A machine we can't probe is not a reason to lose the shell.
        console.warn("[covault] CLI detection failed:", e);
        this.resolved = { env: { ...this.host.baseEnv }, found: [], context: {} };
        return this.resolved;
      });
    }
    return this.pending;
  }

  /** The env run_command should use. Falls back to the inherited one until
   *  the probe (kicked off at the start of every ask) has landed. */
  env(): Record<string, string | undefined> {
    return this.resolved?.env ?? this.host.baseEnv;
  }

  /**
   * Same env, but waits for the probe instead of falling back.
   *
   * Callers that spawn a process cannot use the fallback: a bare
   * Finder-launched PATH turns `"command": "uvx"` into ENOENT, and the
   * settings page's Check button runs before any question has ever
   * triggered the probe. Costs one login-shell read the first time.
   */
  async envReady(): Promise<Record<string, string | undefined>> {
    return (await this.probe()).env;
  }

  /** The system-prompt block, or null if there's nothing to advertise. */
  async manifest(): Promise<string | null> {
    const { found, context } = await this.probe();
    return renderCliManifest({
      platform: this.host.platform,
      cwd: this.deps.cwd(),
      found,
      context,
      declared: this.deps.declared(),
    });
  }
}

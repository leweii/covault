/**
 * The Ask agent's tool surface. Every tool — builtin, shell, MCP — meets
 * the same small interface, so the loop in ask.ts treats them uniformly
 * and the approval gate can't be bypassed by a tool having its own path.
 *
 * Approval model: a tool that returns a non-null needsApproval() string
 * only runs after the UI confirms that exact action with the user.
 * Read-only library tools never need approval; shell commands always do.
 */
import { exec } from "child_process";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import type { ManifestRepo } from "../covault/manifest";
import { searchLibraries, readLibraryNote } from "../covault/librarySearch";
import { describeJob, type BackgroundJob, type BackgroundJobs } from "./backgroundJobs";

export interface AskToolOutcome {
  text: string;
  isError?: boolean;
}

/** What the user is asked to allow before a gated tool runs. */
export interface ApprovalRequest {
  /** Short action line ("$ git log", "jira: search", "Edit refunds.md"). */
  action: string;
  /** Unified diff to render when the action changes a file. Actions
   *  carrying a diff are confirmed every time — never remembered. */
  diff?: string;
}

export interface AskTool {
  name: string;
  description: string;
  parameters: TSchema;
  /** Status line shown in the UI while the tool runs. */
  statusFor: (args: Record<string, unknown>) => string;
  /** The approval the action needs, or null to run freely. May throw to
   *  reject the call outright (e.g. a path outside the libraries). */
  needsApproval?: (args: Record<string, unknown>) => ApprovalRequest | null;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<AskToolOutcome>;
}

export interface LibraryToolDeps {
  vaultBase: () => string;
  repos: () => ManifestRepo[];
}

export function makeSearchTool(deps: LibraryToolDeps): AskTool {
  return {
    name: "search_notes",
    description:
      "Search every note in the vault — team knowledge libraries and the user's personal notes — for a query. Returns the best-matching note paths with a few matching lines each. Optionally restrict to one library (its folder path or name from the map).",
    parameters: Type.Object({
      query: Type.String({ description: "Free-text search terms (any language)." }),
      library: Type.Optional(Type.String({ description: "Library folder path or name to search in. Omit to search all." })),
    }),
    statusFor: (args) => (args.library ? `Searching ${String(args.library)}…` : "Searching the libraries…"),
    execute: async (args) => {
      const query = String(args.query ?? "");
      const library = args.library ? String(args.library) : undefined;
      const hits = searchLibraries(deps.vaultBase(), deps.repos(), query, library);
      if (hits.length === 0) return { text: "No matching notes." };
      return { text: hits.map((h) => `${h.path}\n${h.lines.map((l) => `  > ${l}`).join("\n")}`).join("\n\n") };
    },
  };
}

export function makeReadTool(deps: LibraryToolDeps): AskTool {
  return {
    name: "read_note",
    description: "Read one note's full content by its vault-relative path (as returned by search_notes).",
    parameters: Type.Object({
      path: Type.String({ description: "Vault-relative note path, e.g. teams/ccp-kb/02_domain/refunds.md" }),
    }),
    statusFor: (args) => `Reading ${String(args.path ?? "").split("/").pop() || "note"}…`,
    execute: async (args) => {
      const notePath = String(args.path ?? "");
      const content = readLibraryNote(deps.vaultBase(), deps.repos(), notePath);
      if (content === null) {
        return { text: `Note not found or outside the libraries: ${notePath}`, isError: true };
      }
      return { text: content };
    },
  };
}

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 16_000;

/** Shell access — gated by a per-command user approval to run.
 *
 *  env supplies the user's real login-shell PATH (see cliInventory.ts):
 *  Obsidian launched from the Dock inherits a bare PATH, so without it
 *  homebrew/gcloud/bq are simply "command not found".
 *
 *  `jobs` is what makes a command longer than COMMAND_TIMEOUT_MS
 *  possible at all: with run_in_background the process is detached and
 *  the conversation is woken when it exits (backgroundJobs.ts). Without
 *  a registry the tool is foreground-only, which is all the tests and
 *  any non-Ask caller need. */
export function makeRunCommandTool(
  cwd: () => string,
  env?: () => Record<string, string | undefined>,
  jobs?: BackgroundJobs,
): AskTool {
  const background = jobs
    ? " Anything that can take longer than 30 seconds — builds, pipelines, downloads, long queries — must be started with run_in_background: true instead: it returns immediately with a job id, and you are woken up automatically with the output the moment it exits. Never wait with sleep and never poll a log in a loop; both waste the whole conversation."
    : "";
  return {
    name: "run_command",
    description:
      "Run a shell command in the vault directory and return its output. Use for anything the note tools can't answer: git history, file conversions, querying live data with the CLIs listed in your system prompt (bq, gcloud, psql, …). The user approves every command before it runs." +
      background,
    parameters: Type.Object({
      command: Type.String({ description: "The exact shell command to run." }),
      ...(jobs
        ? {
            run_in_background: Type.Optional(
              Type.Boolean({
                description:
                  "Run detached and return at once. Use for anything that may take more than ~30s; you are woken automatically when it exits.",
              }),
            ),
          }
        : {}),
    }),
    statusFor: (args) => {
      const command = String(args.command ?? "");
      const short = command.length > 60 ? `${command.slice(0, 60)}…` : command;
      return args.run_in_background ? `Started in the background: ${short}` : `Running: ${short}`;
    },
    needsApproval: (args) => ({
      action: `$ ${String(args.command ?? "")}${args.run_in_background ? "  (in the background)" : ""}`,
    }),
    execute: (args, signal) => {
      const command = String(args.command ?? "");
      if (jobs && args.run_in_background) {
        try {
          const job = jobs.start(command);
          return Promise.resolve({
            text: `Started ${job.id} in the background (log: ${job.logPath}).\nStop your turn now and say what you are waiting for — you will be woken with the output when ${job.id} exits. Do not sleep or poll.`,
          });
        } catch (e) {
          return Promise.resolve({ text: (e as Error).message, isError: true });
        }
      }
      return new Promise((resolve) => {
        const child = exec(
          command,
          { cwd: cwd(), env: env?.() as NodeJS.ProcessEnv | undefined, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            let text = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n").trim();
            if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`;
            if (error) {
              // A timeout is not a failure of the command, it is the
              // wrong tool: say so, or the model tries the same thing
              // again with a sleep in front of it.
              const reason = error.killed
                ? `timed out after ${COMMAND_TIMEOUT_MS / 1000}s${jobs ? " — re-run it with run_in_background: true instead of waiting" : ""}`
                : `exit code ${error.code ?? "?"}`;
              resolve({ text: `Command failed (${reason}).\n${text}`, isError: true });
            } else {
              resolve({ text: text || "(no output)" });
            }
          },
        );
        signal?.addEventListener("abort", () => child.kill());
      });
    },
  };
}

/**
 * Looking in on, and stopping, the commands running in the background.
 *
 * Neither is how the model learns a job is done — the wake-up is — so
 * check_command says as much in its own description. It is for the
 * halfway look ("is the build past the tests yet?") and for re-reading
 * output that has scrolled out of the conversation.
 */
export function makeJobTools(jobs: BackgroundJobs): AskTool[] {
  const status = (job: BackgroundJob) => `${describeJob(job)}\n$ ${job.command}`;
  return [
    {
      name: "check_command",
      description:
        "Look at the background commands started with run_command(run_in_background: true): status, and the tail of the output. You do NOT need this to find out that a job finished — that wakes you on its own. Use it to peek at progress while a job is still running, or to re-read output.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Job id (e.g. bg1). Omit to list every job." })),
      }),
      statusFor: (args) => (args.id ? `Checking ${String(args.id)}…` : "Checking background commands…"),
      execute: async (args) => {
        const id = args.id ? String(args.id) : "";
        if (!id) {
          const all = jobs.list();
          if (all.length === 0) return { text: "No background commands have been started." };
          return { text: all.map(status).join("\n\n") };
        }
        const job = jobs.get(id);
        if (!job) return { text: `No such background command: ${id}.`, isError: true };
        const tail = jobs.tail(id);
        return { text: `${status(job)}\n\nOutput so far:\n${tail || "(nothing yet)"}` };
      },
    },
    {
      name: "stop_command",
      description: "Stop a running background command and everything it started.",
      parameters: Type.Object({
        id: Type.String({ description: "Job id (e.g. bg1)." }),
      }),
      statusFor: (args) => `Stopping ${String(args.id ?? "job")}…`,
      needsApproval: (args) => ({ action: `Stop background command ${String(args.id ?? "")}` }),
      execute: async (args) => {
        const id = String(args.id ?? "");
        const job = jobs.get(id);
        if (!job) return { text: `No such background command: ${id}.`, isError: true };
        if (!jobs.stop(id)) return { text: `${describeJob(job)} — nothing to stop.` };
        return { text: `Stopping ${id}. You will be woken when it is gone.` };
      },
    },
  ];
}

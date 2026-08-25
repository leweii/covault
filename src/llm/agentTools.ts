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

export interface AskToolOutcome {
  text: string;
  isError?: boolean;
}

export interface AskTool {
  name: string;
  description: string;
  parameters: TSchema;
  /** Status line shown in the UI while the tool runs. */
  statusFor: (args: Record<string, unknown>) => string;
  /** Human-readable action needing user approval, or null to run freely. */
  needsApproval?: (args: Record<string, unknown>) => string | null;
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
      "Search the knowledge libraries for notes matching a query. Returns the best-matching note paths with a few matching lines each. Optionally restrict to one library (its folder path or name from the map).",
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

/** Shell access — gated twice: a settings toggle to exist at all, and a
 *  per-command user approval to run. */
export function makeRunCommandTool(cwd: () => string): AskTool {
  return {
    name: "run_command",
    description:
      "Run a shell command in the vault directory and return its output. Use for anything the note tools can't answer: git history, file conversions, external CLIs. The user approves every command before it runs.",
    parameters: Type.Object({
      command: Type.String({ description: "The exact shell command to run." }),
    }),
    statusFor: (args) => {
      const command = String(args.command ?? "");
      return `Running: ${command.length > 60 ? `${command.slice(0, 60)}…` : command}`;
    },
    needsApproval: (args) => `$ ${String(args.command ?? "")}`,
    execute: (args, signal) =>
      new Promise((resolve) => {
        const command = String(args.command ?? "");
        const child = exec(
          command,
          { cwd: cwd(), timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            let text = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n").trim();
            if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`;
            if (error) {
              const reason = error.killed ? `timed out after ${COMMAND_TIMEOUT_MS / 1000}s` : `exit code ${error.code ?? "?"}`;
              resolve({ text: `Command failed (${reason}).\n${text}`, isError: true });
            } else {
              resolve({ text: text || "(no output)" });
            }
          },
        );
        signal?.addEventListener("abort", () => child.kill());
      }),
  };
}

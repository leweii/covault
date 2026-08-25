/**
 * Note editing for the Ask agent, on pi-agent-core's own edit/write tools
 * (the pi coding agent's battle-tested semantics: targeted oldText →
 * newText replacements with fuzzy-match fallback, whole-file writes).
 *
 * What this wrapper adds is Covault's contract:
 *  - edits stay inside the knowledge libraries — same boundary as reading;
 *  - nothing is written before the user approves a concrete diff
 *    (needsApproval carries the preview; the gate in ask.ts enforces it);
 *  - every successful mutation pokes the sync loop, so the change is
 *    committed and shared like any hand-made edit — git history is the
 *    undo button, File History shows the change.
 */
import * as fs from "fs";
import * as path from "path";
import { createTwoFilesPatch } from "diff";
import { createEditTool, createWriteTool, type ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { contentText } from "@earendil-works/pi-ai";
import type { ManifestRepo } from "../covault/manifest";
import type { ApprovalRequest, AskTool } from "./agentTools";

export interface EditToolDeps {
  vaultBase: () => string;
  repos: () => ManifestRepo[];
  /** Called after a successful write — kicks the sync loop. */
  onMutation: () => void;
}

/** Vault-relative path that resolves inside one of the libraries, or null. */
function insideLibrary(deps: EditToolDeps, p: string): string | null {
  const base = deps.vaultBase();
  const resolved = path.resolve(base, p);
  const ok = deps.repos().some((r) => {
    const root = path.resolve(base, r.path);
    return resolved === root || resolved.startsWith(root + path.sep);
  });
  return ok ? resolved : null;
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Unified diff for the approval dialog. */
function previewDiff(relPath: string, before: string, after: string): string {
  return createTwoFilesPatch(relPath, relPath, before, after, "current", "proposed", { context: 3 });
}

/**
 * Preview of targeted edits: exact first-occurrence replacement. The
 * harness applies smarter fuzzy matching on execute; when an oldText
 * doesn't match exactly here, the preview says so instead of guessing.
 */
function applyEditsPreview(content: string, edits: { oldText: string; newText: string }[]): { after: string; misses: number } {
  let after = content;
  let misses = 0;
  for (const e of edits) {
    if (after.includes(e.oldText)) after = after.replace(e.oldText, e.newText);
    else misses += 1;
  }
  return { after, misses };
}

export function makeEditTools(deps: EditToolDeps): AskTool[] {
  const context: ExecutionToolContext = { env: new NodeExecutionEnv({ cwd: deps.vaultBase() }) };
  const inner = { edit: createEditTool(), write: createWriteTool() };

  const guard = (args: Record<string, unknown>): { rel: string; abs: string } | ApprovalRequest => {
    const rel = String(args.path ?? "");
    const abs = insideLibrary(deps, rel);
    if (!abs) throw new Error(`"${rel}" is outside the knowledge libraries — notes there cannot be changed.`);
    return { rel, abs };
  };

  const editNote: AskTool = {
    name: "edit_note",
    description:
      "Make targeted changes to a note in a knowledge library: one or more exact oldText → newText replacements. " +
      "Each oldText must be unique in the file and must not overlap other edits. The user reviews a diff before anything is written.",
    parameters: inner.edit.parameters,
    statusFor: (args) => `Editing ${String(args.path ?? "").split("/").pop() || "note"}…`,
    needsApproval: (args) => {
      const { rel, abs } = guard(args) as { rel: string; abs: string };
      const before = readIfExists(abs);
      if (before === null) throw new Error(`Note not found: ${rel}`);
      const edits = (args.edits ?? []) as { oldText: string; newText: string }[];
      const { after, misses } = applyEditsPreview(before, edits);
      const note = misses > 0 ? `\n(${misses} edit(s) did not match exactly — fuzzy matching will be attempted.)` : "";
      return { action: `Edit ${rel}`, diff: previewDiff(rel, before, after) + note };
    },
    execute: async (args, signal) => {
      guard(args);
      try {
        const result = await inner.edit.execute("ask", args as never, signal, undefined, context);
        deps.onMutation();
        return { text: contentText(result.content as never) || "Edited." };
      } catch (e) {
        return { text: (e as Error).message, isError: true };
      }
    },
  };

  const writeNote: AskTool = {
    name: "write_note",
    description:
      "Create a new note (or fully replace an existing one) in a knowledge library. Prefer edit_note for changes to " +
      "existing notes. The user reviews the content before anything is written.",
    parameters: inner.write.parameters,
    statusFor: (args) => `Writing ${String(args.path ?? "").split("/").pop() || "note"}…`,
    needsApproval: (args) => {
      const { rel, abs } = guard(args) as { rel: string; abs: string };
      const before = readIfExists(abs) ?? "";
      const after = String(args.content ?? "");
      return {
        action: before ? `Replace ${rel}` : `Create ${rel}`,
        diff: previewDiff(rel, before, after),
      };
    },
    execute: async (args, signal) => {
      guard(args);
      try {
        const result = await inner.write.execute("ask", args as never, signal, undefined, context);
        deps.onMutation();
        return { text: contentText(result.content as never) || "Written." };
      } catch (e) {
        return { text: (e as Error).message, isError: true };
      }
    },
  };

  return [editNote, writeNote];
}

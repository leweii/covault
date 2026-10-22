/**
 * The note tools an automation agent works with: search, read, list,
 * write, edit. Whole vault, team libraries included — automations are
 * allowed to change any note, and a change to a library reaches teammates
 * on the next sync like any hand-made edit (git history is the undo).
 *
 * One boundary holds for reading and writing alike (agentPathAllowed):
 * inside the vault, never machinery (.obsidian, .git, .covault, .trash).
 * Writes go through the Obsidian vault API, so open editors and the
 * file explorer see them at once.
 */
import * as fs from "fs";
import * as path from "path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ManifestRepo } from "../covault/manifest";
import { agentPathAllowed, readLibraryNote, searchLibraries } from "../covault/librarySearch";

export interface NoteToolDeps {
  vaultBase: () => string;
  repos: () => ManifestRepo[];
  /** Create or overwrite a note (vault-relative path), creating folders. */
  writeNote: (vaultPath: string, content: string) => Promise<void>;
}

const MAX_LIST_ENTRIES = 200;

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: {} };
}

/** The vault-relative path, normalized — or a thrown, model-readable error. */
function guard(vaultBase: string, raw: unknown, { note = false } = {}): { rel: string; abs: string } {
  const rel = (typeof raw === "string" ? raw : "").replace(/^\/+/, "");
  const abs = agentPathAllowed(vaultBase, rel);
  if (!abs) throw new Error(`"${rel}" is outside the vault or inside its machinery — not allowed.`);
  if (note && !rel.toLowerCase().endsWith(".md")) throw new Error(`"${rel}" isn't a note — only .md files can be written.`);
  return { rel: path.relative(vaultBase, abs).split(path.sep).join("/"), abs };
}

export function makeNoteTools(deps: NoteToolDeps, onChanged: (vaultPath: string) => void): AgentTool[] {
  const searchNotes: AgentTool = {
    name: "search_notes",
    label: "Search notes",
    description:
      "Search every note in the vault — team knowledge libraries and personal notes — for a query. Returns the best-matching note paths with a few matching lines each. Optionally restrict to one library (its folder path or repo name).",
    parameters: Type.Object({
      query: Type.String({ description: "Free-text search terms (any language)." }),
      library: Type.Optional(Type.String({ description: "Library folder path or name. Omit to search everything." })),
    }),
    execute: async (_id, params) => {
      const p = params as { query: string; library?: string };
      const hits = searchLibraries(deps.vaultBase(), deps.repos(), p.query, p.library);
      if (hits.length === 0) return text("No matching notes.");
      return text(hits.map((h) => `${h.path}\n${h.lines.map((l) => `  > ${l}`).join("\n")}`).join("\n\n"));
    },
  };

  const readNote: AgentTool = {
    name: "read_note",
    label: "Read note",
    description: "Read one note's full content by its vault-relative path.",
    parameters: Type.Object({ path: Type.String({ description: "Vault-relative path, e.g. teams/ccp-kb/refunds.md" }) }),
    execute: async (_id, params) => {
      const { rel } = guard(deps.vaultBase(), (params as { path: string }).path);
      const content = readLibraryNote(deps.vaultBase(), deps.repos(), rel);
      if (content === null) throw new Error(`Note not found: ${rel}`);
      return text(content);
    },
  };

  const listFolder: AgentTool = {
    name: "list_folder",
    label: "List folder",
    description:
      'List the notes and subfolders directly inside a folder (vault-relative; "" for the vault root), with each note\'s last-modified time.',
    parameters: Type.Object({ path: Type.String({ description: 'Folder path, or "" for the root.' }) }),
    execute: async (_id, params) => {
      const raw = (params as { path: string }).path ?? "";
      const base = deps.vaultBase();
      const abs = raw.trim() === "" ? base : guard(base, raw).abs;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        throw new Error(`Folder not found: ${raw}`);
      }
      const lines = entries
        .filter((e) => !e.name.startsWith("."))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .slice(0, MAX_LIST_ENTRIES)
        .map((e) => {
          if (e.isDirectory()) return `${e.name}/`;
          let when = "";
          try {
            when = `  (modified ${new Date(fs.statSync(path.join(abs, e.name)).mtimeMs).toISOString().slice(0, 16)})`;
          } catch {
            /* unreadable: list it without a time */
          }
          return `${e.name}${when}`;
        });
      return text(lines.length > 0 ? lines.join("\n") : "(empty folder)");
    },
  };

  const writeNote: AgentTool = {
    name: "write_note",
    label: "Write note",
    description:
      "Create a note, or replace an existing note's entire content. Missing folders are created. Prefer edit_note for changing part of an existing note.",
    parameters: Type.Object({
      path: Type.String({ description: "Vault-relative path ending in .md" }),
      content: Type.String({ description: "The complete new content of the note." }),
    }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const p = params as { path: string; content: string };
      const { rel, abs } = guard(deps.vaultBase(), p.path, { note: true });
      const existed = fs.existsSync(abs);
      await deps.writeNote(rel, p.content);
      onChanged(rel);
      return text(`${existed ? "Replaced" : "Created"} ${rel} (${p.content.length} chars).`);
    },
  };

  const editNote: AgentTool = {
    name: "edit_note",
    label: "Edit note",
    description:
      "Make targeted changes to an existing note: one or more exact oldText → newText replacements. Each oldText must appear exactly once in the note (include enough surrounding text to make it unique).",
    parameters: Type.Object({
      path: Type.String({ description: "Vault-relative path of an existing .md note." }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({ description: "Exact text to replace (must be unique in the note)." }),
          newText: Type.String({ description: "Replacement text." }),
        }),
        { minItems: 1 },
      ),
    }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const p = params as { path: string; edits: { oldText: string; newText: string }[] };
      const { rel, abs } = guard(deps.vaultBase(), p.path, { note: true });
      let content: string;
      try {
        content = fs.readFileSync(abs, "utf8");
      } catch {
        throw new Error(`Note not found: ${rel} — use write_note to create it.`);
      }
      const after = applyEdits(content, p.edits);
      await deps.writeNote(rel, after);
      onChanged(rel);
      return text(`Edited ${rel} (${p.edits.length} change(s)).`);
    },
  };

  return [searchNotes, readNote, listFolder, writeNote, editNote];
}

/** Apply exact, unique replacements in order; any miss fails the whole edit. */
export function applyEdits(content: string, edits: { oldText: string; newText: string }[]): string {
  let out = content;
  for (const [i, e] of edits.entries()) {
    if (!e.oldText) throw new Error(`Edit ${i + 1}: oldText is empty.`);
    const first = out.indexOf(e.oldText);
    if (first < 0) throw new Error(`Edit ${i + 1}: oldText not found — read the note again and copy it exactly.`);
    if (out.indexOf(e.oldText, first + 1) >= 0) {
      throw new Error(`Edit ${i + 1}: oldText appears more than once — include more surrounding text.`);
    }
    out = out.slice(0, first) + e.newText + out.slice(first + e.oldText.length);
  }
  return out;
}

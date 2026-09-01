/**
 * Generates the vault's knowledge-routing skill: which knowledge library
 * answers which kind of question, and how to look inside it.
 *
 * It is a plain Agent Skill — YAML frontmatter with name/description,
 * instructions in the body — written to the folders agents already read,
 * Claude Code's and pi's, in project scope. No covault-private location
 * and no covault-private format: the same file serves the plugin's own
 * Ask agent (llm/skills.ts), any coding agent run in the vault, and
 * anything else that can read Markdown.
 *
 * The file is DERIVED DATA, rebuilt from the manifest and the libraries'
 * own content after every sync. It is never synced anywhere: each device
 * regenerates its own (see ALWAYS_EXCLUDED and the managed .gitignore
 * block), so it can never cause a merge conflict. The user's own skills
 * in those same folders are untouched, and sync normally.
 */
import * as fs from "fs";
import * as path from "path";
import type { ManifestRepo } from "./manifest";
import { repoNameFromUrl } from "../git/urls";

export const SKILL_NAME = "team-knowledge";

/** The folders we own — one per agent convention (Claude Code, pi,
 *  Codex), same bytes in each. Vault-relative and posix-separated: these
 *  strings also go into the managed .gitignore block and the sync
 *  exclusions. */
export const SKILL_DIRS = [
  `.claude/skills/${SKILL_NAME}`,
  `.pi/skills/${SKILL_NAME}`,
  `.codex/skills/${SKILL_NAME}`,
];
export const SKILL_TARGETS = SKILL_DIRS.map((d) => `${d}/SKILL.md`);

/** Older versions kept this file in .covault/skills — a private folder
 *  no agent ever looked in. Nothing to move: it is derived data, so the
 *  migration is deleting it and letting the rebuild land in the standard
 *  folders instead. */
const LEGACY_SKILL_DIR = ".covault/skills";

/** Walk caps: a routing index needs shape, not an exhaustive census. */
const MAX_FILES_COUNTED = 5000;
const MAX_TOP_ENTRIES = 12;
const README_EXCERPT_CHARS = 400;
/** The Agent Skills spec caps a description at 1024 characters, and a
 *  loader that hits the cap warns instead of routing. The trigger names
 *  are what grows, so that is what gets trimmed. */
const MAX_DESCRIPTION_CHARS = 1024;
/** Beyond a handful, more names stop helping the routing decision. */
const MAX_TRIGGER_NAMES = 15;

export interface LibraryFacts {
  repo: ManifestRepo;
  name: string;
  noteCount: number;
  topEntries: string[]; // "guides/ (12 notes)" or "faq.md"
  readmeExcerpt: string | null;
  readmePath: string | null;
}

/** Recursively count .md files, skipping git internals. Capped. */
function countNotes(dir: string, budget: { left: number }): number {
  let count = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (budget.left <= 0) return count;
    if (e.name === ".git" || e.name === ".covault") continue;
    if (e.isDirectory()) {
      count += countNotes(path.join(dir, e.name), budget);
    } else if (e.name.toLowerCase().endsWith(".md")) {
      count += 1;
      budget.left -= 1;
    }
  }
  return count;
}

/** First meaningful lines of a README, headings stripped down to text. */
function readmeExcerpt(file: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  // Drop frontmatter, keep the first prose lines.
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
  const lines = body
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  let out = "";
  for (const line of lines) {
    if (out.length >= README_EXCERPT_CHARS) break;
    out += (out ? " " : "") + line;
  }
  return out.length > README_EXCERPT_CHARS ? `${out.slice(0, README_EXCERPT_CHARS)}…` : out;
}

export function gatherFacts(vaultBase: string, repo: ManifestRepo): LibraryFacts {
  const dir = path.join(vaultBase, repo.path);
  const name = repoNameFromUrl(repo.url);

  let topEntries: string[] = [];
  let readmeFile: string | null = null;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && e.name !== ".git" && !e.name.startsWith("."))
      .map((e) => {
        const n = countNotes(path.join(dir, e.name), { left: MAX_FILES_COUNTED });
        return { label: `${e.name}/ (${n} note${n === 1 ? "" : "s"})`, notes: n };
      })
      .sort((a, b) => b.notes - a.notes);
    const files = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => e.name)
      .sort();
    const readmeName = files.find((f) => f.toLowerCase() === "readme.md");
    if (readmeName) readmeFile = path.join(dir, readmeName);
    topEntries = [...dirs.map((d) => d.label), ...files].slice(0, MAX_TOP_ENTRIES);
  } catch {
    /* folder missing (not cloned yet) — still list the library */
  }

  return {
    repo,
    name,
    noteCount: countNotes(dir, { left: MAX_FILES_COUNTED }),
    topEntries,
    readmeExcerpt: readmeFile ? readmeExcerpt(readmeFile) : null,
    readmePath: readmeFile ? path.join(repo.path, path.basename(readmeFile)) : null,
  };
}

const EMPTY_DESCRIPTION = "No team knowledge libraries are installed in this vault yet.";

/** The frontmatter description — the only thing an agent sees before it
 *  decides to read the skill, so it names the libraries. As many as fit
 *  under the spec's cap; the body lists them all either way. */
function describeLibraries(names: string[]): string {
  const prefix = "Routes questions to the team knowledge libraries in this vault (";
  const suffix = "). Consult the matching library folder before answering anything these topics touch.";
  const listed: string[] = [];
  for (const name of names.slice(0, MAX_TRIGGER_NAMES)) {
    const next = [...listed, name].join(", ");
    if (prefix.length + next.length + suffix.length + 2 > MAX_DESCRIPTION_CHARS) break;
    listed.push(name);
  }
  const trimmed = listed.length < names.length ? `${listed.join(", ")}, …` : listed.join(", ");
  return `${prefix}${trimmed}${suffix}`;
}

/** Build the full skill document. Deterministic for identical vault state. */
export function buildKnowledgeSkill(vaultBase: string, repos: ManifestRepo[]): string {
  const facts = [...repos].sort((a, b) => a.path.localeCompare(b.path)).map((r) => gatherFacts(vaultBase, r));
  const description = facts.length === 0 ? EMPTY_DESCRIPTION : describeLibraries(facts.map((f) => f.name));

  const lines: string[] = [
    "---",
    "name: team-knowledge",
    `description: ${description}`,
    "---",
    "",
    "# Team knowledge libraries",
    "",
    "<!-- Generated by Covault. Do not edit: rebuilt after every sync. -->",
    "",
    "Each folder below is a knowledge library shared by the team and kept",
    "in sync automatically. When a question touches one of these topics,",
    "read the matching folder before answering from general knowledge —",
    "the library is the source of truth.",
    "",
    "How to look inside a library:",
    "",
    "1. Start from its README or the entry notes listed under *Contents*.",
    "2. Otherwise scan file names and headings of the `*.md` files in the folder.",
    "3. When notes disagree, prefer the most recently modified one.",
    "",
  ];

  if (facts.length === 0) {
    lines.push("_No libraries installed yet. Add one via the Covault panel._", "");
  }

  for (const f of facts) {
    lines.push(`## ${f.name} — \`${f.repo.path}/\``, "");
    lines.push(`- Source: ${f.repo.url.replace(/\.git$/, "")} (${f.repo.branch})`);
    lines.push(`- Size: ${f.noteCount} note${f.noteCount === 1 ? "" : "s"}`);
    if (f.readmePath) lines.push(`- Start here: \`${f.readmePath}\``);
    if (f.topEntries.length > 0) lines.push(`- Contents: ${f.topEntries.join(", ")}`);
    if (f.readmeExcerpt) lines.push("", `> ${f.readmeExcerpt}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Write the skill to every target folder, iff its content changed.
 *  Returns whether anything changed on disk. A vault with no libraries
 *  gets nothing — an empty routing table in a shared skills folder is
 *  pure noise for every agent that reads it. */
export function writeKnowledgeSkill(vaultBase: string, repos: ManifestRepo[]): boolean {
  if (repos.length === 0) {
    removeKnowledgeSkill(vaultBase);
    return false;
  }
  const next = buildKnowledgeSkill(vaultBase, repos);
  let changed = false;
  for (const target of SKILL_TARGETS) {
    const file = path.join(vaultBase, target);
    let current: string | null = null;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {
      /* first run */
    }
    if (current === next) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
    changed = true;
  }
  return changed;
}

/** Remove the generated skill and tidy up the folders we created. Only
 *  ours go: rmdir refuses a folder holding anyone else's skills. */
export function removeKnowledgeSkill(vaultBase: string): void {
  for (const dir of SKILL_DIRS) {
    fs.rmSync(path.join(vaultBase, dir), { recursive: true, force: true });
    const parts = dir.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      try {
        fs.rmdirSync(path.join(vaultBase, ...parts.slice(0, i)));
      } catch {
        break; // not empty (or gone) — and neither is anything above it
      }
    }
  }
}

/** Drop the pre-standard-folders copy of the map. Idempotent. */
export function migrateLegacySkill(vaultBase: string): void {
  fs.rmSync(path.join(vaultBase, LEGACY_SKILL_DIR), { recursive: true, force: true });
}

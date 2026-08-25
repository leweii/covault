/**
 * Adapter layer: thin, well-known files that tell coding agents working
 * in this vault that team knowledge libraries exist and where the full
 * map is (the kernel index, .covault/skills/team-knowledge.md).
 *
 *   AGENTS.md   — the cross-vendor agent-instructions standard
 *   CLAUDE.md   — Claude Code
 *   .claude/skills/team-knowledge/SKILL.md — the Agent Skills mechanism
 *
 * INVARIANT: everything here is a pure function of the manifest repos.
 * These files live at the vault root and may sync with the personal KB;
 * only deterministic output keeps two devices from producing different
 * bytes and merge-conflicting on every sync. Anything device- or
 * time-dependent (note counts, README excerpts, dates) belongs in the
 * kernel index, never here.
 *
 * AGENTS.md/CLAUDE.md may hold the user's own instructions — we own only
 * a fenced block (same pattern as the managed .gitignore block). The
 * SKILL.md file is entirely ours.
 */
import * as fs from "fs";
import * as path from "path";
import type { ManifestRepo } from "./manifest";
import { repoNameFromUrl } from "../git/urls";
import { SKILL_RELPATH } from "./skill";

const START = "<!-- >>> covault managed — do not edit between markers <<< -->";
const END = "<!-- <<< covault managed >>> -->";

const SKILL_DIR_RELPATH = ".claude/skills/team-knowledge";
/** Vault-root files that receive the managed block. */
const BLOCK_TARGETS = ["AGENTS.md", "CLAUDE.md"];

function sorted(repos: ManifestRepo[]): ManifestRepo[] {
  return [...repos].sort((a, b) => a.path.localeCompare(b.path));
}

function libraryLine(repo: ManifestRepo): string {
  const name = repoNameFromUrl(repo.url);
  const desc = repo.description?.trim();
  return desc ? `- ${name} — \`${repo.path}/\` — ${desc}` : `- ${name} — \`${repo.path}/\``;
}

/** The block AGENTS.md and CLAUDE.md share. Pure function of the repos. */
export function buildAgentBlock(repos: ManifestRepo[]): string {
  const libs = sorted(repos);
  return [
    START,
    "## Team knowledge libraries",
    "",
    `This vault contains ${libs.length} team knowledge librar${libs.length === 1 ? "y" : "ies"}, kept in sync by the Covault plugin:`,
    "",
    ...libs.map(libraryLine),
    "",
    `Before answering any question these topics touch, read \`${SKILL_RELPATH}\` —`,
    "the full, always-fresh map of every library (entry points, structure,",
    "summaries) — then consult the matching library folder. The libraries",
    "are the source of truth.",
    END,
  ].join("\n");
}

/** The Agent Skills file. Pure function of the repos. */
export function buildSkillFile(repos: ManifestRepo[]): string {
  const libs = sorted(repos);
  const names = libs.map((r) => repoNameFromUrl(r.url));
  return [
    "---",
    "name: team-knowledge",
    `description: Routes questions to the team knowledge libraries in this vault (${names.join(", ")}). Use whenever a question touches these teams or topics.`,
    "---",
    "",
    `Read \`${SKILL_RELPATH}\` for the full library map — per-library entry`,
    "points, folder structure, and summaries, regenerated after every sync.",
    "Then answer from the matching library folder:",
    "",
    "1. Start from the library's README or the entry notes the map lists.",
    "2. Otherwise scan file names and headings of its `*.md` files.",
    "3. When notes disagree, prefer the most recently modified one.",
    "",
    "Libraries:",
    "",
    ...libs.map(libraryLine),
    "",
  ].join("\n");
}

/** Insert or replace the managed block in `file`. Returns whether it wrote. */
export function applyManagedBlock(file: string, block: string): boolean {
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    /* file doesn't exist yet */
  }

  let next: string;
  if (existing === null) {
    next = `${block}\n`;
  } else {
    const startIdx = existing.indexOf(START);
    const endIdx = existing.indexOf(END);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      next = existing.slice(0, startIdx) + block + existing.slice(endIdx + END.length);
    } else {
      next = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n\n${block}\n` : `${existing}${existing ? "\n" : ""}${block}\n`;
    }
  }
  if (next === existing) return false;
  fs.writeFileSync(file, next);
  return true;
}

/** Remove the managed block; delete the file when nothing else is in it. */
export function removeManagedBlock(file: string): void {
  let existing: string;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  const startIdx = existing.indexOf(START);
  const endIdx = existing.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return;
  const rest = (existing.slice(0, startIdx) + existing.slice(endIdx + END.length)).replace(/\n{3,}/g, "\n\n");
  if (rest.trim().length === 0) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, rest);
}

/** Write/refresh every adapter. No libraries → same as removal (an empty
 *  routing table is pure noise in someone's vault). Returns whether
 *  anything changed on disk. */
export function writeAdapters(vaultBase: string, repos: ManifestRepo[]): boolean {
  if (repos.length === 0) {
    removeAdapters(vaultBase);
    return false;
  }
  let changed = false;
  const block = buildAgentBlock(repos);
  for (const target of BLOCK_TARGETS) {
    changed = applyManagedBlock(path.join(vaultBase, target), block) || changed;
  }

  const skillFile = path.join(vaultBase, SKILL_DIR_RELPATH, "SKILL.md");
  const next = buildSkillFile(repos);
  let current: string | null = null;
  try {
    current = fs.readFileSync(skillFile, "utf8");
  } catch {
    /* first run */
  }
  if (current !== next) {
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, next);
    changed = true;
  }
  return changed;
}

/** Remove everything the adapter layer owns (toggle off / no libraries). */
export function removeAdapters(vaultBase: string): void {
  for (const target of BLOCK_TARGETS) removeManagedBlock(path.join(vaultBase, target));
  fs.rmSync(path.join(vaultBase, SKILL_DIR_RELPATH), { recursive: true, force: true });
  // Leave .claude/skills (and .claude) alone unless we emptied it.
  try {
    fs.rmdirSync(path.join(vaultBase, ".claude", "skills"));
    fs.rmdirSync(path.join(vaultBase, ".claude"));
  } catch {
    /* not empty or missing — the user's business */
  }
}

/**
 * Agent Skills for the Ask agent — the same skills the user's coding
 * agents already read, found in the conventional folders rather than any
 * covault-private one:
 *
 *   project scope (this vault)   user scope (this machine)
 *   .claude/skills               ~/.claude/skills        Claude Code
 *   .pi/skills                   ~/.pi/agent/skills      pi
 *   .codex/skills                ~/.codex/skills         Codex
 *
 * Discovery and the SKILL.md format come straight from pi-agent-core, so
 * a skill that works in Claude Code, the pi CLI or Codex works here
 * unchanged: frontmatter name/description, instructions in the body,
 * support files beside it. Project scope is searched first, so a vault's
 * own skill wins a name collision with a personal one — the rule all
 * three CLIs use.
 *
 * Progressive disclosure is the point: only each skill's name and
 * description ride in the system prompt, and load_skill fetches the body
 * once the model decides the skill applies. It is also the only way in —
 * read_note refuses dot folders, and user-scope skills sit outside the
 * vault entirely. Reading needs no approval (they are the user's own
 * files) but never leaves the skill's own folder.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Type } from "typebox";
import { formatSkillInvocation, loadSkills, type Skill } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AskTool } from "./agentTools";

/** A support file is a note-sized read, not a data dump. */
const MAX_SUPPORT_FILE_CHARS = 24_000;

/** pi honours PI_CODING_AGENT_DIR and Codex honours CODEX_HOME; the rest
 *  is convention. */
function agentHome(envVar: string, ...fallback: string[]): string {
  return process.env[envVar]?.trim() || path.join(os.homedir(), ...fallback);
}

/** Every folder skills are read from, project scope first. */
export function skillDirs(vaultBase: string): string[] {
  return [
    path.join(vaultBase, ".claude", "skills"),
    path.join(vaultBase, ".pi", "skills"),
    path.join(vaultBase, ".codex", "skills"),
    path.join(os.homedir(), ".claude", "skills"),
    path.join(agentHome("PI_CODING_AGENT_DIR", ".pi", "agent"), "skills"),
    // Codex preinstalls its own skills under .system, which the loader
    // skips with every other dot folder — they are built on tools only
    // Codex has, so that is the right outcome.
    path.join(agentHome("CODEX_HOME", ".codex"), "skills"),
  ];
}

export interface AskSkills {
  /** The <available_skills> block for the system prompt. */
  prompt: string;
  /** load_skill, bound to this snapshot of what's on disk. */
  tools: AskTool[];
}

/**
 * Every skill on disk, deduped by name (first folder wins).
 *
 * `exclude` drops files by absolute path: the generated team-knowledge
 * skill is already in the prompt verbatim as the library map, and
 * listing it again would only invite the model to load what it can
 * already read.
 */
export async function discoverSkills(vaultBase: string, exclude: string[] = []): Promise<Skill[]> {
  const env = new NodeExecutionEnv({ cwd: vaultBase });
  const { skills } = await loadSkills(env, skillDirs(vaultBase));
  const skip = new Set(exclude.map((f) => path.resolve(f)));
  const byName = new Map<string, Skill>();
  for (const skill of skills) {
    if (skip.has(path.resolve(skill.filePath))) continue;
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The listing agentskills.io specifies, with our own way in (load_skill
 *  rather than a read tool that can't reach these paths). */
export function formatSkillsPrompt(skills: Skill[]): string {
  const lines = [
    "=== Skills available to you ===",
    "Each skill below is a set of instructions for one kind of task, written by the user or their team for the AI agents on this machine. When a request matches a skill's description, call load_skill with that name BEFORE starting the work and follow what it returns — for that task it outranks your own defaults. The location is where the skill lives; pass load_skill a `file` to read anything it points at beside it.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push(
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      "  </skill>",
    );
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/** Read-only, and confined to the folder of the skill it names. */
export function makeLoadSkillTool(skills: Skill[]): AskTool {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    name: "load_skill",
    description:
      "Load the full instructions of a skill listed in <available_skills>. Call it as soon as a task matches a skill's description, then follow the instructions it returns. Pass `file` to read one of the support files those instructions point at, relative to the skill's own folder.",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name, exactly as listed in <available_skills>." }),
      file: Type.Optional(
        Type.String({ description: "Support file to read instead, relative to the skill's folder (e.g. references/palette.md)." }),
      ),
    }),
    statusFor: (args) => {
      const name = String(args.name ?? "skill");
      return args.file ? `Reading ${String(args.file)} (${name})…` : `Loading the ${name} skill…`;
    },
    execute: async (args) => {
      const name = String(args.name ?? "").trim();
      const skill = byName.get(name);
      if (!skill) {
        return { text: `No such skill: ${name}. Available: ${[...byName.keys()].join(", ") || "none"}.`, isError: true };
      }
      const file = args.file ? String(args.file) : "";
      if (!file) return { text: formatSkillInvocation(skill) };

      const baseDir = path.dirname(skill.filePath);
      const resolved = path.resolve(baseDir, file);
      if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
        return { text: `Outside the ${name} skill's folder: ${file}`, isError: true };
      }
      try {
        const content = fs.readFileSync(resolved, "utf8");
        const capped =
          content.length > MAX_SUPPORT_FILE_CHARS ? `${content.slice(0, MAX_SUPPORT_FILE_CHARS)}\n…(truncated)` : content;
        return { text: `${path.relative(baseDir, resolved)} (${name} skill):\n\n${capped}` };
      } catch {
        return { text: `Can't read ${file} in the ${name} skill.`, isError: true };
      }
    },
  };
}

/**
 * The whole skill surface for one question: prompt block plus the tool
 * that opens them. null when there is nothing to advertise — a vault
 * with no skills should not pay for a section explaining that.
 *
 * Resolved per question, so a skill written mid-conversation is picked
 * up by the next one. A failure here is never fatal: skills are an
 * addition to the agent, not a dependency of it.
 */
export async function loadAskSkills(vaultBase: string, opts: { exclude?: string[] } = {}): Promise<AskSkills | null> {
  let skills: Skill[];
  try {
    skills = await discoverSkills(vaultBase, opts.exclude);
  } catch (e) {
    console.warn("[covault] couldn't load skills:", e);
    return null;
  }
  const listed = skills.filter((s) => !s.disableModelInvocation);
  if (listed.length === 0) return null;
  // Skills marked disable-model-invocation stay loadable by name — that
  // is what the flag means — they are only left out of the listing.
  return { prompt: formatSkillsPrompt(listed), tools: [makeLoadSkillTool(skills)] };
}

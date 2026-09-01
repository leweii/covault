/**
 * Vault-root .gitignore maintenance. Shared-library folders are nested
 * independent repos; if the vault root is itself a git repo, those paths
 * must be ignored or a `git add` would create broken gitlink entries
 * (mode 160000 without .gitmodules). We own a fenced block and leave the
 * rest of the file to the user.
 */
import * as fs from "fs";
import * as path from "path";
import { SKILL_DIRS } from "./skill";

const START = "# >>> covault managed — do not edit between markers <<<";
const END = "# <<< covault managed >>>";

export function ensureIgnored(vaultBase: string, repoPaths: string[]): void {
  const file = path.join(vaultBase, ".gitignore");
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    /* no .gitignore yet */
  }

  // The main repo's git directory must never be swallowed by a vault-root
  // .git managed by another tool — it rides in the managed block always.
  const entries = [
    ...repoPaths.map((p) => `/${p.replace(/\/+$/, "")}/`),
    "/.covault/main.git/",
    // Obsidian's vault trash: deleted library folders land here, and their
    // contents must not resurface in a vault-root repo another tool syncs.
    "/.trash/",
    // The generated team-knowledge skill: derived data, regenerated per
    // device — synced nowhere, by anything. Only ours; the user's own
    // skills in those folders sync like any other file.
    ...SKILL_DIRS.map((d) => `/${d}/`),
    // Local diagnostics: this machine's problem, and potentially large.
    // Kept for vaults written by an older version, which put the log here.
    "/.covault/logs/",
  ].sort();
  const block = [START, ...entries, END].join("\n");

  const startIdx = existing.indexOf(START);
  const endIdx = existing.indexOf(END);
  let next: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    next = existing.slice(0, startIdx) + block + existing.slice(endIdx + END.length);
  } else {
    next = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n${block}\n` : `${existing}${block}\n`;
  }
  if (next !== existing) fs.writeFileSync(file, next);
}

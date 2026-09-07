/**
 * One-way removal of a feature that used to live here.
 *
 * Covault once maintained a fenced block in the vault's AGENTS.md and
 * CLAUDE.md, listing the team knowledge libraries and pointing coding
 * agents at the generated team-knowledge skill. The skill stayed; the
 * block did not — agents that read skills find it on their own, and a
 * plugin editing files at the vault root is a bigger footprint than that
 * one pointer was worth.
 *
 * What remains is the cleanup, kept because those files are the user's:
 * only the marker-fenced region is ours, so everything outside it — the
 * instructions someone wrote by hand — has to survive.
 *
 * It runs on load and after every sync pass, not once behind a migration
 * flag. AGENTS.md sits at the vault root and may sync with the personal
 * KB, so a block can still arrive from a device on an older version;
 * this way it gets swept up too. On a vault that never had one the whole
 * pass is two failed reads.
 */
import * as fs from "fs";
import * as path from "path";

const START = "<!-- >>> covault managed — do not edit between markers <<< -->";
const END = "<!-- <<< covault managed >>> -->";

/** The vault-root files that used to receive the block. */
const BLOCK_TARGETS = ["AGENTS.md", "CLAUDE.md"];

/**
 * Strip our block from one file, keeping whatever else is in it. The
 * file goes only when it held nothing but the block — that file was
 * created by us, so leaving an empty one behind is just litter.
 */
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

/** Sweep both vault-root files. */
export function purgeLegacyAgentBlock(vaultBase: string): void {
  for (const target of BLOCK_TARGETS) removeManagedBlock(path.join(vaultBase, target));
}

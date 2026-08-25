/**
 * Local search across the whole vault — the tool half of Ask.
 * Plain filesystem walks and case-insensitive term matching; no index to
 * build or invalidate, which at vault scale (hundreds to a few thousand
 * notes, not millions) is fast enough and can never go stale.
 *
 * Scope: everything in the vault — team libraries AND the user's own
 * notes (their call, their vault, their model key). Machinery is always
 * out: dot-directories (.obsidian, .trash, .covault, nested .git) never
 * reach a prompt, and paths can never resolve outside the vault.
 */
import * as fs from "fs";
import * as path from "path";
import type { ManifestRepo } from "./manifest";

const MAX_HITS = 12;
const MAX_LINES_PER_FILE = 3;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES_SCANNED = 4000;
const SNIPPET_CHARS = 200;
const MAX_READ_CHARS = 24_000;

export interface SearchHit {
  /** Vault-relative note path. */
  path: string;
  /** How many distinct terms matched (filename hits count double). */
  score: number;
  /** Up to MAX_LINES_PER_FILE matching lines, trimmed. */
  lines: string[];
}

function walkMd(dir: string, budget: { left: number }, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (budget.left <= 0) return;
    if (e.name === ".git" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(full, budget, out);
    else if (e.name.toLowerCase().endsWith(".md")) {
      out.push(full);
      budget.left -= 1;
    }
  }
}

/** Split a free-text query into lowercase terms worth matching. */
function termsOf(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[\s,;/、，。？?!！]+/).filter((t) => t.length >= 2))];
}

/**
 * Search the vault (optionally restricted to one library, by vault path
 * or repo name) for notes matching the query terms. Returns the
 * best-scoring notes with a few matching lines each.
 */
export function searchLibraries(
  vaultBase: string,
  repos: ManifestRepo[],
  query: string,
  library?: string,
): SearchHit[] {
  const terms = termsOf(query);
  if (terms.length === 0) return [];

  const roots = library
    ? repos
        .filter((r) => r.path === library || r.path.endsWith(`/${library}`) || r.url.includes(`/${library}`))
        .map((r) => path.join(vaultBase, r.path))
    : [vaultBase]; // whole vault: libraries and personal notes alike

  const files: string[] = [];
  const budget = { left: MAX_FILES_SCANNED };
  for (const root of roots) walkMd(root, budget, files);

  const hits: SearchHit[] = [];
  for (const file of files) {
    const rel = path.relative(vaultBase, file);
    const nameLc = path.basename(file).toLowerCase();
    let score = 0;
    for (const t of terms) if (nameLc.includes(t)) score += 2;

    let lines: string[] = [];
    try {
      if (fs.statSync(file).size <= MAX_FILE_BYTES) {
        const content = fs.readFileSync(file, "utf8");
        const contentLc = content.toLowerCase();
        const matched = new Set<string>();
        for (const t of terms) if (contentLc.includes(t)) matched.add(t);
        score += matched.size;
        if (matched.size > 0) {
          lines = content
            .split("\n")
            .filter((l) => {
              const lc = l.toLowerCase();
              return terms.some((t) => lc.includes(t));
            })
            .slice(0, MAX_LINES_PER_FILE)
            .map((l) => (l.length > SNIPPET_CHARS ? `${l.slice(0, SNIPPET_CHARS)}…` : l.trim()));
        }
      }
    } catch {
      /* unreadable — filename score may still count */
    }

    if (score > 0) hits.push({ path: rel, score, lines });
  }

  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, MAX_HITS);
}

/**
 * Is this vault-relative path fair game for the agent? Inside the vault,
 * and with no dot-component anywhere (blocks .obsidian, .trash, .covault,
 * nested .git — and ../ escapes, since those resolve outside the base).
 */
export function agentPathAllowed(vaultBase: string, notePath: string): string | null {
  const resolved = path.resolve(vaultBase, notePath);
  if (resolved !== vaultBase && !resolved.startsWith(vaultBase + path.sep)) return null;
  const rel = path.relative(vaultBase, resolved);
  if (rel.split(path.sep).some((part) => part.startsWith("."))) return null;
  return resolved;
}

/**
 * Read one note, capped. Returns null when the path leaves the vault,
 * touches machinery, or doesn't exist.
 */
export function readLibraryNote(vaultBase: string, _repos: ManifestRepo[], notePath: string): string | null {
  const resolved = agentPathAllowed(vaultBase, notePath);
  if (!resolved) return null;
  try {
    const content = fs.readFileSync(resolved, "utf8");
    return content.length > MAX_READ_CHARS ? `${content.slice(0, MAX_READ_CHARS)}\n…(truncated)` : content;
  } catch {
    return null;
  }
}

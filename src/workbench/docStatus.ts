/**
 * Document status — the one people set by hand ("Draft", "Approved"…).
 *
 * It lives in the note's frontmatter, not in Covault's own files: the
 * note already travels to every teammate, Obsidian's properties panel can
 * show and edit it, and nothing is lost if the plugin is removed. Three
 * keys: `status` (the label), `status_by`, `status_at` (ISO time) — the
 * last two only when Covault writes it, so "set by X · 2 days ago" has
 * something to say.
 *
 * Pure: reads a frontmatter object and mutates one for processFrontMatter.
 * No Obsidian imports, so it is unit-tested as-is.
 */
import { DEFAULT_DOC_STATUSES, type DocStatusDef } from "../settings";

export const STATUS_KEY = "status";
export const STATUS_BY_KEY = "status_by";
export const STATUS_AT_KEY = "status_at";

export interface DocStatus {
  /** The matching definition, or null for a label the team's list doesn't have. */
  def: DocStatusDef | null;
  /** The label as written in the note. */
  raw: string;
  by?: string;
  /** ms */
  at?: number;
}

export function readDocStatus(frontmatter: Record<string, unknown> | null | undefined, defs: DocStatusDef[]): DocStatus | null {
  const raw = frontmatter?.[STATUS_KEY];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const label = raw.trim();
  const def = defs.find((d) => d.label.toLowerCase() === label.toLowerCase() || d.id === label.toLowerCase()) ?? null;
  const by = frontmatter?.[STATUS_BY_KEY];
  const at = parseWhen(frontmatter?.[STATUS_AT_KEY]);
  return { def, raw: label, ...(typeof by === "string" && by ? { by } : {}), ...(at !== undefined ? { at } : {}) };
}

function parseWhen(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

/** Set (or, with null, clear) the status on a frontmatter object. */
export function writeDocStatus(fm: Record<string, unknown>, def: DocStatusDef | null, by: string, now = new Date()): void {
  if (!def) {
    delete fm[STATUS_KEY];
    delete fm[STATUS_BY_KEY];
    delete fm[STATUS_AT_KEY];
    return;
  }
  fm[STATUS_KEY] = def.label;
  fm[STATUS_BY_KEY] = by;
  fm[STATUS_AT_KEY] = now.toISOString();
}

const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

/**
 * The status list from untrusted input (data.json by hand, a pasted
 * export): well-formed entries with unique ids, or null when there is
 * nothing usable — callers then keep what they had.
 */
export function sanitizeDocStatuses(raw: unknown): DocStatusDef[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DocStatusDef[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const label = typeof r.label === "string" ? r.label.trim() : "";
    if (!label) continue;
    const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : statusIdFor(label, out);
    if (ids.has(id)) continue;
    ids.add(id);
    out.push({ id, label, color: isHexColor(r.color) ? r.color.toLowerCase() : fallbackColor(out.length) });
  }
  return out.length > 0 ? out : null;
}

/** A slug for a new status, unique among `existing`. */
export function statusIdFor(label: string, existing: DocStatusDef[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "status";
  let id = base;
  for (let n = 2; existing.some((s) => s.id === id); n++) id = `${base}-${n}`;
  return id;
}

function fallbackColor(index: number): string {
  return DEFAULT_DOC_STATUSES[index % DEFAULT_DOC_STATUSES.length]?.color ?? "#8a8a8a";
}

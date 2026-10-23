/**
 * Line diffs for the Time Machine, as pure functions over strings:
 *  - a version against the one before it, as a flat list of kept /
 *    added / removed lines (rendered as the whole document, changes
 *    marked in place);
 *  - several consecutive versions combined, with each added line
 *    credited to the version that introduced it;
 *  - the selection rules for picking those versions (checkboxes that
 *    keep the range contiguous — changes only combine over an unbroken
 *    stretch of history).
 */
import { diffLines } from "diff";

export interface DiffOp {
  kind: "ctx" | "add" | "del";
  text: string;
}

export function lineDiff(before: string, after: string): DiffOp[] {
  const ops: DiffOp[] = [];
  for (const part of diffLines(before, after)) {
    const lines = part.value.split("\n");
    if (lines.at(-1) === "") lines.pop(); // the trailing newline isn't a line
    const kind: DiffOp["kind"] = part.added ? "add" : part.removed ? "del" : "ctx";
    for (const text of lines) ops.push({ kind, text });
  }
  return ops;
}

export function diffStats(before: string, after: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const op of lineDiff(before, after)) {
    if (op.kind === "add") added++;
    else if (op.kind === "del") deleted++;
  }
  return { added, deleted };
}

export interface VersionText {
  text: string;
  author: string;
}

/**
 * Who added each `add` line of a combined diff. `versions` are the
 * selected versions newest first; `base` is the text before the oldest
 * of them. A line is credited to the newest version that has it while
 * the version before doesn't; a line that was moved rather than written
 * (present in the base too) gets no credit.
 */
export function creditAdditions(ops: DiffOp[], versions: VersionText[], base: string): (string | null)[] {
  const lineSets = versions.map((v) => new Set(v.text.split("\n")));
  const baseLines = new Set(base.split("\n"));
  return ops.map((op) => {
    if (op.kind !== "add") return null;
    for (let k = 0; k < versions.length; k++) {
      const older = k + 1 < versions.length ? lineSets[k + 1]! : baseLines;
      if (lineSets[k]!.has(op.text) && !older.has(op.text)) return versions[k]!.author;
    }
    return null;
  });
}

/** Selected versions, as indices into a newest-first list; lo ≤ hi. */
export interface Range {
  lo: number;
  hi: number;
}

export function single(k: number): Range {
  return { lo: k, hi: k };
}

/** Shift-click: everything between the anchor and `k`. */
export function rangeBetween(anchor: number, k: number): Range {
  return { lo: Math.min(anchor, k), hi: Math.max(anchor, k) };
}

/**
 * A checkbox toggled. Outside the range → the range grows to include it
 * (and everything between). At either end → that end is dropped. In the
 * middle → refused, since that would split the range. The only selected
 * version can't be unticked.
 */
export function toggleInRange(sel: Range, k: number): { sel: Range; refused: boolean } {
  if (k < sel.lo) return { sel: { lo: k, hi: sel.hi }, refused: false };
  if (k > sel.hi) return { sel: { lo: sel.lo, hi: k }, refused: false };
  if (sel.lo === sel.hi) return { sel, refused: false };
  if (k === sel.lo) return { sel: { lo: sel.lo + 1, hi: sel.hi }, refused: false };
  if (k === sel.hi) return { sel: { lo: sel.lo, hi: sel.hi - 1 }, refused: false };
  return { sel, refused: true };
}

/** Shift+↑ grows towards newer versions, Shift+↓ towards older ones. */
export function growRange(sel: Range, direction: "newer" | "older", count: number): Range {
  if (direction === "newer") return { lo: Math.max(0, sel.lo - 1), hi: sel.hi };
  return { lo: sel.lo, hi: Math.min(count - 1, sel.hi + 1) };
}

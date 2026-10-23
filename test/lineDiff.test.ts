import { describe, expect, it } from "vitest";
import {
  creditAdditions,
  diffStats,
  growRange,
  lineDiff,
  rangeBetween,
  single,
  toggleInRange,
} from "../src/workbench/lineDiff";

describe("lineDiff", () => {
  it("lists every line, marking what changed, without a phantom trailing line", () => {
    const ops = lineDiff("# T\n\n- a\n- b\n", "# T\n\n- a\n- B\n- c\n");
    expect(ops).toEqual([
      { kind: "ctx", text: "# T" },
      { kind: "ctx", text: "" },
      { kind: "ctx", text: "- a" },
      { kind: "del", text: "- b" },
      { kind: "add", text: "- B" },
      { kind: "add", text: "- c" },
    ]);
    expect(diffStats("# T\n\n- a\n- b\n", "# T\n\n- a\n- B\n- c\n")).toEqual({ added: 2, deleted: 1 });
  });

  it("treats the first version as all additions", () => {
    expect(lineDiff("", "a\nb\n").every((o) => o.kind === "add")).toBe(true);
  });
});

describe("creditAdditions", () => {
  // Newest first: v0 by Cato added "- sesame"; v1 by Brooker added "- cross";
  // base (before v1) had neither. "- a" is in the base: moved, not written.
  const base = "- a\n";
  const v1 = { author: "Brooker Fang", text: "- a\n- cross\n" };
  const v0 = { author: "Cato Wen", text: "- cross\n- sesame\n- a\n" };

  it("credits each added line to the version that introduced it", () => {
    const ops = lineDiff(base, v0.text);
    const credit = creditAdditions(ops, [v0, v1], base);
    const added = ops.map((o, i) => [o, credit[i]] as const).filter(([o]) => o.kind === "add");
    expect(added.map(([o, who]) => [o.text, who])).toEqual([
      ["- cross", "Brooker Fang"],
      ["- sesame", "Cato Wen"],
    ]);
    // Context lines get no credit.
    expect(credit.filter((c, i) => ops[i]!.kind !== "add").every((c) => c === null)).toBe(true);
  });

  it("gives no credit to a line that merely moved", () => {
    const ops = lineDiff("- a\n- b\n", "- b\n- a\n");
    const credit = creditAdditions(ops, [{ author: "X", text: "- b\n- a\n" }], "- a\n- b\n");
    expect(credit.filter((c) => c !== null)).toEqual([]);
  });
});

describe("selection rules", () => {
  it("shift-click selects everything between the anchor and the click", () => {
    expect(rangeBetween(3, 1)).toEqual({ lo: 1, hi: 3 });
    expect(single(2)).toEqual({ lo: 2, hi: 2 });
  });

  it("ticking outside the range grows it; unticking an end trims it; the middle is refused", () => {
    expect(toggleInRange({ lo: 2, hi: 2 }, 4)).toEqual({ sel: { lo: 2, hi: 4 }, refused: false });
    expect(toggleInRange({ lo: 2, hi: 4 }, 0)).toEqual({ sel: { lo: 0, hi: 4 }, refused: false });
    expect(toggleInRange({ lo: 0, hi: 4 }, 4)).toEqual({ sel: { lo: 0, hi: 3 }, refused: false });
    expect(toggleInRange({ lo: 0, hi: 3 }, 0)).toEqual({ sel: { lo: 1, hi: 3 }, refused: false });
    expect(toggleInRange({ lo: 1, hi: 3 }, 2)).toEqual({ sel: { lo: 1, hi: 3 }, refused: true });
  });

  it("never unticks the only selected version", () => {
    expect(toggleInRange({ lo: 1, hi: 1 }, 1)).toEqual({ sel: { lo: 1, hi: 1 }, refused: false });
  });

  it("grows with the keyboard inside the list's bounds", () => {
    expect(growRange({ lo: 1, hi: 1 }, "newer", 5)).toEqual({ lo: 0, hi: 1 });
    expect(growRange({ lo: 0, hi: 1 }, "newer", 5)).toEqual({ lo: 0, hi: 1 });
    expect(growRange({ lo: 0, hi: 4 }, "older", 5)).toEqual({ lo: 0, hi: 4 });
    expect(growRange({ lo: 0, hi: 3 }, "older", 5)).toEqual({ lo: 0, hi: 4 });
  });
});

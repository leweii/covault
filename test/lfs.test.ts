/** Pointer format, path rules and endpoint derivation for Git LFS. */
import { describe, expect, it } from "vitest";
import { POINTER_MAX_BYTES, formatPointer, gitattributesLines, isLfsPath, lfsEndpoint, parsePointer } from "../src/git/lfs";

const oid = "a".repeat(64);

describe("LFS pointer format", () => {
  it("round-trips", () => {
    const text = formatPointer({ oid, size: 12345 });
    expect(parsePointer(text)).toEqual({ oid, size: 12345 });
  });

  it("stays under the spec's pointer size cap", () => {
    expect(formatPointer({ oid, size: Number.MAX_SAFE_INTEGER }).length).toBeLessThan(POINTER_MAX_BYTES);
  });

  it("rejects things that merely resemble a pointer", () => {
    expect(parsePointer("# My note about git-lfs\n")).toBeNull();
    expect(parsePointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\n`)).toBeNull(); // no size
    expect(parsePointer(`version https://git-lfs.github.com/spec/v1\noid sha256:XYZ\nsize 3\n`)).toBeNull();
    expect(parsePointer("")).toBeNull();
  });
});

describe("isLfsPath", () => {
  it("matches attachment extensions, case-insensitively", () => {
    expect(isLfsPath("img/Screenshot.PNG")).toBe(true);
    expect(isLfsPath("docs/deck.pptx")).toBe(true);
    expect(isLfsPath("recordings/standup.mp4")).toBe(true);
  });

  it("leaves notes and extension-less files alone", () => {
    expect(isLfsPath("notes/plan.md")).toBe(false);
    expect(isLfsPath("LICENSE")).toBe(false);
    expect(isLfsPath("diagram.svg")).toBe(false); // svg is diffable text
  });
});

describe("lfsEndpoint", () => {
  it("appends .git when the remote URL lacks it", () => {
    expect(lfsEndpoint("https://github.com/org/repo")).toBe("https://github.com/org/repo.git/info/lfs");
    expect(lfsEndpoint("https://github.com/org/repo.git")).toBe("https://github.com/org/repo.git/info/lfs");
    expect(lfsEndpoint("https://github.com/org/repo.git/")).toBe("https://github.com/org/repo.git/info/lfs");
  });
});

describe("gitattributesLines", () => {
  it("mirrors isLfsPath so CLI clones behave identically", () => {
    const lines = gitattributesLines();
    expect(lines).toContain("*.png filter=lfs diff=lfs merge=lfs -text");
    for (const line of lines) {
      const ext = /^\*\.(\w+) /.exec(line)?.[1];
      expect(ext, line).toBeDefined();
      expect(isLfsPath(`x.${ext}`)).toBe(true);
    }
  });
});

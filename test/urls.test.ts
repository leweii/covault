import { describe, expect, it } from "vitest";
import { ownerFromUrl, repoNameFromUrl, sameRemote } from "../src/git/urls";

describe("ownerFromUrl", () => {
  it("extracts the org from a github https url", () => {
    expect(ownerFromUrl("https://github.com/chancetop/platform-kb.git")).toBe("chancetop");
  });
  it("works without the .git suffix and with deeper hosts", () => {
    expect(ownerFromUrl("https://git.example.com/team-a/kb")).toBe("team-a");
  });
  it("rejects urls without an owner segment", () => {
    expect(() => ownerFromUrl("https://github.com/")).toThrow();
  });
});

describe("repoNameFromUrl", () => {
  it("strips the .git suffix", () => {
    expect(repoNameFromUrl("https://github.com/chancetop/platform-kb.git")).toBe("platform-kb");
  });
});

describe("sameRemote", () => {
  it("ignores the .git suffix, a trailing slash, and case", () => {
    expect(sameRemote("https://github.com/ct-kb/handbook.git", "https://github.com/CT-KB/handbook/")).toBe(true);
  });
  it("tells different repositories apart", () => {
    expect(sameRemote("https://github.com/ct-kb/handbook.git", "https://github.com/ct-kb/other.git")).toBe(false);
  });
});

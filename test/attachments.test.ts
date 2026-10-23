import { describe, expect, it } from "vitest";
import { libraryAttachmentFolder, normalizeAttachmentFolder } from "../src/covault/attachments";

const repos = [
  { path: "teams/team-cookbook-kb", url: "u", branch: "main" },
  { path: "teams/team-oms-kb", url: "u", branch: "main" },
];

describe("normalizeAttachmentFolder", () => {
  it("cleans up slashes and spaces", () => {
    expect(normalizeAttachmentFolder(" /assets/images/ ")).toBe("assets/images");
    expect(normalizeAttachmentFolder("a\\b")).toBe("a/b");
    expect(normalizeAttachmentFolder("./attachments")).toBe("attachments");
    expect(normalizeAttachmentFolder("")).toBe("");
  });

  it("refuses paths that leave the library or hit machinery", () => {
    expect(() => normalizeAttachmentFolder("../outside")).toThrow(/isn't allowed/);
    expect(() => normalizeAttachmentFolder("a/../../b")).toThrow(/isn't allowed/);
    expect(() => normalizeAttachmentFolder(".git")).toThrow(/isn't allowed/);
  });
});

describe("libraryAttachmentFolder", () => {
  it("puts a library note's attachments under that library's root", () => {
    expect(libraryAttachmentFolder(repos, "teams/team-cookbook-kb/01_doc/deep/a.md", "attachments")).toBe(
      "teams/team-cookbook-kb/attachments",
    );
  });

  it("leaves notes outside every library to Obsidian", () => {
    expect(libraryAttachmentFolder(repos, "A0-Inbox/idea.md", "attachments")).toBeNull();
    // A sibling folder that merely shares the prefix is not inside the library.
    expect(libraryAttachmentFolder(repos, "teams/team-cookbook-kb-old/a.md", "attachments")).toBeNull();
  });

  it("is off when the setting is empty or there is no note", () => {
    expect(libraryAttachmentFolder(repos, "teams/team-oms-kb/a.md", "")).toBeNull();
    expect(libraryAttachmentFolder(repos, undefined, "attachments")).toBeNull();
  });
});

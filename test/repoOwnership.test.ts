/**
 * Which repo owns a vault path decides whether the panel offers a note's
 * history at all. The bug: ownership by the personal repo was decided by
 * the manifest's `include` list, which only whole-vault scope's opposite
 * uses — so in a fully backed-up vault every note reported "isn't synced".
 *
 * The rule lives in covault/ownership.ts so this exercises it directly.
 */
import { describe, expect, it } from "vitest";
import { ownerKeyForPath } from "../src/covault/ownership";
import type { MainKbScope } from "../src/covault/manifest";

const libs = ["Z01-Wonder/team-ccp-kb"];

describe("who owns a vault path", () => {
  it("gives a note inside a library to that library", () => {
    expect(ownerKeyForPath("Z01-Wonder/team-ccp-kb/notes/a.md", { libraries: libs, hasPersonal: true, scope: "vault", include: [] })).toBe(
      "Z01-Wonder/team-ccp-kb",
    );
  });

  /** The reported bug, in one line. */
  it("gives any other note to the personal repo when the whole vault is backed up", () => {
    expect(ownerKeyForPath("A0-Inbox/思考.md", { libraries: libs, hasPersonal: true, scope: "vault", include: [] })).toBe("");
  });

  it("in marked scope, only what was marked belongs to the personal repo", () => {
    const marked = { libraries: libs, hasPersonal: true, scope: "marked" as MainKbScope, include: ["A3-Permanent"] };
    expect(ownerKeyForPath("A3-Permanent/note.md", marked)).toBe("");
    expect(ownerKeyForPath("A0-Inbox/思考.md", marked)).toBeNull();
  });

  it("owns nothing when there is no personal repo", () => {
    expect(ownerKeyForPath("A0-Inbox/思考.md", { libraries: libs, hasPersonal: false, scope: "vault", include: [] })).toBeNull();
  });

  it("doesn't mistake a sibling folder for a library by prefix", () => {
    // "…-kb-archive" starts with the library path but is not inside it.
    expect(
      ownerKeyForPath("Z01-Wonder/team-ccp-kb-archive/a.md", { libraries: libs, hasPersonal: true, scope: "vault", include: [] }),
    ).toBe("");
  });
});

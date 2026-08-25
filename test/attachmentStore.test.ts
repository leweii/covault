/**
 * The point of this store is that chats.json never grows a megabyte of
 * base64 — so the tests check both halves: bytes land on disk, and the
 * folders don't outlive their sessions.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AttachmentStore } from "../src/covault/attachmentStore";
import { ChatStore, type ChatSession } from "../src/covault/chatStore";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "covault-attach-"));
}

const png = { data: Buffer.from("pretend png").toString("base64"), mimeType: "image/png", name: "shot.png" };

describe("AttachmentStore", () => {
  it("writes the decoded bytes and reads them back as base64", () => {
    const root = tmp();
    const store = new AttachmentStore(root);
    const ref = store.save("s1", png, 0);
    expect(fs.readFileSync(path.join(root, "s1", ref.file), "utf8")).toBe("pretend png");
    expect(store.read("s1", ref)).toBe(png.data);
  });

  it("names the file by mime type", () => {
    const store = new AttachmentStore(tmp());
    expect(store.save("s1", { ...png, mimeType: "image/jpeg" }, 0).file).toMatch(/\.jpg$/);
    expect(store.save("s1", { ...png, mimeType: "image/webp" }, 1).file).toMatch(/\.webp$/);
  });

  it("keeps several images of one turn apart", () => {
    const store = new AttachmentStore(tmp());
    const a = store.save("s1", png, 0);
    const b = store.save("s1", png, 1);
    expect(a.file).not.toBe(b.file);
  });

  it("reports a missing file as null rather than throwing", () => {
    const store = new AttachmentStore(tmp());
    expect(store.read("s1", { file: "gone.png", mimeType: "image/png", name: "gone.png" })).toBeNull();
  });

  it("deletes one session's images", () => {
    const root = tmp();
    const store = new AttachmentStore(root);
    store.save("s1", png, 0);
    store.save("s2", png, 0);
    store.deleteSession("s1");
    expect(fs.existsSync(path.join(root, "s1"))).toBe(false);
    expect(fs.existsSync(path.join(root, "s2"))).toBe(true);
  });

  it("prunes folders whose session is gone", () => {
    const root = tmp();
    const store = new AttachmentStore(root);
    store.save("keep", png, 0);
    store.save("drop", png, 0);
    store.prune(["keep"]);
    expect(fs.existsSync(path.join(root, "keep"))).toBe(true);
    expect(fs.existsSync(path.join(root, "drop"))).toBe(false);
  });

  it("prunes quietly when nothing was ever written", () => {
    expect(() => new AttachmentStore(path.join(tmp(), "nope")).prune(["s1"])).not.toThrow();
  });
});

describe("ChatStore + attachments", () => {
  function session(id: string): ChatSession {
    return { id, title: id, updatedAt: 1, turns: [{ question: "q", activity: [] }], transcript: [] };
  }

  it("drops a deleted session's images", () => {
    const dir = tmp();
    const store = new ChatStore(path.join(dir, "chats.json"));
    store.save(session("s1"));
    const ref = store.attachments.save("s1", png, 0);
    store.delete("s1");
    expect(store.attachments.read("s1", ref)).toBeNull();
  });

  it("keeps images of sessions that are still listed", () => {
    const dir = tmp();
    const store = new ChatStore(path.join(dir, "chats.json"));
    store.save(session("s1"));
    const ref = store.attachments.save("s1", png, 0);
    store.save(session("s2")); // triggers a prune
    expect(store.attachments.read("s1", ref)).toBe(png.data);
  });
});

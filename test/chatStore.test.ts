import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatStore, titleFor, type ChatSession } from "../src/covault/chatStore";

let dir: string;
let store: ChatStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "covault-chat-"));
  store = new ChatStore(path.join(dir, "deep", "chats.json"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function session(id: string, at = Date.now()): ChatSession {
  return { id, title: `chat ${id}`, updatedAt: at, turns: [{ question: "q", activity: [] }], transcript: [{ role: "user" }] };
}

describe("ChatStore", () => {
  it("saves newest-first, updates in place, deletes, survives a fresh read", () => {
    store.save(session("a", 1));
    store.save(session("b", 2));
    expect(store.list().map((s) => s.id)).toEqual(["b", "a"]);

    store.save({ ...session("a", 3), title: "renamed" });
    expect(store.list()[0]).toMatchObject({ id: "a", title: "renamed" });

    store.delete("b");
    expect(store.list().map((s) => s.id)).toEqual(["a"]);
    expect(store.list()[0]?.transcript).toEqual([{ role: "user" }]);
  });

  it("caps the history at 50 sessions", () => {
    for (let i = 0; i < 55; i++) store.save(session(String(i), i));
    const list = store.list();
    expect(list).toHaveLength(50);
    expect(list[0]?.id).toBe("54");
  });

  it("returns empty on missing or corrupt files", () => {
    expect(store.list()).toEqual([]);
    fs.mkdirSync(path.join(dir, "deep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "deep", "chats.json"), "{nope");
    expect(store.list()).toEqual([]);
  });
});

describe("titleFor", () => {
  it("takes the first line, truncated", () => {
    expect(titleFor("退款流程是怎样的？\n第二行")).toBe("退款流程是怎样的？");
    expect(titleFor("x".repeat(60))).toHaveLength(49);
    expect(titleFor("  ")).toBe("New chat");
  });
});

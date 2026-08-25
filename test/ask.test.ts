import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { searchLibraries, readLibraryNote } from "../src/covault/librarySearch";
import { AskEngine } from "../src/llm/ask";
import type { ManifestRepo } from "../src/covault/manifest";
import type { AssistantMessage, MutableModels } from "@earendil-works/pi-ai";

let vault: string;
const repos = (): ManifestRepo[] => [
  { path: "teams/ccp-kb", url: "https://github.com/ct-kb/ccp-kb.git", branch: "main" },
  { path: "teams/oms-kb", url: "https://github.com/ct-kb/oms-kb.git", branch: "main" },
];

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "covault-ask-"));
  fs.mkdirSync(path.join(vault, "teams/ccp-kb/02_domain"), { recursive: true });
  fs.mkdirSync(path.join(vault, "teams/oms-kb"), { recursive: true });
  fs.mkdirSync(path.join(vault, "private"), { recursive: true });
  fs.writeFileSync(
    path.join(vault, "teams/ccp-kb/02_domain/refunds.md"),
    "# Refund flow\n\nRefunds go through Zendesk first, then OMS cancellation.\n",
  );
  fs.writeFileSync(path.join(vault, "teams/oms-kb/cancel.md"), "# Cancelling orders\nUse the OMS console.\n");
  fs.writeFileSync(path.join(vault, "private/diary.md"), "my secret refund thoughts\n");
});
afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
});

describe("searchLibraries", () => {
  it("finds notes by content and filename, never outside the libraries", () => {
    const hits = searchLibraries(vault, repos(), "refund zendesk");
    expect(hits[0]?.path).toBe("teams/ccp-kb/02_domain/refunds.md");
    expect(hits[0]?.lines.join(" ")).toContain("Zendesk");
    // The private note matches "refund" but is not in any library.
    expect(hits.some((h) => h.path.includes("private"))).toBe(false);
  });

  it("restricts to one library by name or path", () => {
    expect(searchLibraries(vault, repos(), "refund", "oms-kb")).toHaveLength(0);
    expect(searchLibraries(vault, repos(), "cancel", "teams/oms-kb")[0]?.path).toBe("teams/oms-kb/cancel.md");
  });

  it("returns nothing for queries with no usable terms", () => {
    expect(searchLibraries(vault, repos(), "  ? ")).toHaveLength(0);
  });
});

describe("readLibraryNote", () => {
  it("reads library notes and refuses everything else", () => {
    expect(readLibraryNote(vault, repos(), "teams/ccp-kb/02_domain/refunds.md")).toContain("Zendesk");
    expect(readLibraryNote(vault, repos(), "private/diary.md")).toBeNull();
    expect(readLibraryNote(vault, repos(), "teams/ccp-kb/../../private/diary.md")).toBeNull();
    expect(readLibraryNote(vault, repos(), "teams/ccp-kb/missing.md")).toBeNull();
  });
});

describe("AskEngine", () => {
  function fakeModels(script: AssistantMessage["content"][]): MutableModels {
    let call = 0;
    return {
      getModel: () => ({ id: "fake" }),
      completeSimple: async () => ({
        role: "assistant",
        content: script[Math.min(call++, script.length - 1)],
        api: "fake",
        provider: "fake",
        model: "fake",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
        stopReason: "end",
        timestamp: 0,
      }),
    } as unknown as MutableModels;
  }

  function engine(models: MutableModels): AskEngine {
    return new AskEngine({
      models,
      getSelection: () => ({ provider: "fake", model: "fake" }),
      hasKey: () => true,
      vaultBase: () => vault,
      repos,
      libraryMap: () => "## ccp-kb — refunds, Zendesk\n## oms-kb — order cancellation",
    });
  }

  it("runs the search → read → answer loop and reports stats", async () => {
    const ask = engine(
      fakeModels([
        [{ type: "toolCall", id: "1", name: "search_notes", arguments: { query: "refund" } }],
        [{ type: "toolCall", id: "2", name: "read_note", arguments: { path: "teams/ccp-kb/02_domain/refunds.md" } }],
        [{ type: "text", text: "Refunds go through Zendesk first.\n\nSources: [[teams/ccp-kb/02_domain/refunds.md]]" }],
      ]),
    );
    const statuses: string[] = [];
    const answer = await ask.ask("退款流程是怎样的？", { onProgress: (p) => statuses.push(p.text) });
    expect(answer.text).toContain("Zendesk");
    expect(answer.turns).toBe(3);
    expect(answer.toolCalls).toBe(2);
    expect(answer.costUsd).toBeCloseTo(0.03);
    expect(statuses.join(" ")).toContain("Searching");
    expect(statuses.join(" ")).toContain("Reading");
  });

  it("keeps the conversation for follow-up questions until reset", async () => {
    const models = fakeModels([[{ type: "text", text: "answer" }]]);
    const ask = engine(models);
    await ask.ask("q1");
    await ask.ask("q2");
    // 2 user + 2 assistant messages retained
    // (indirectly: a third ask still works after reset)
    ask.reset();
    const a = await ask.ask("q3");
    expect(a.text).toBe("answer");
  });

  it("gives up after the turn cap instead of looping forever", async () => {
    const ask = engine(
      fakeModels([[{ type: "toolCall", id: "x", name: "search_notes", arguments: { query: "refund" } }]]),
    );
    await expect(ask.ask("q")).rejects.toThrow(/kept searching/);
  });
});

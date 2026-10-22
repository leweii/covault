import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  describeSchedule,
  latestSlotAtOrBefore,
  nextRunAfter,
  parseSchedule,
  LATE_GRACE_MS,
} from "../src/automation/schedule";
import { AutomationStore } from "../src/automation/store";
import { applyEdits } from "../src/automation/noteTools";
import { AutomationRunner } from "../src/automation/runner";

const H = 3_600_000;
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe("schedule", () => {
  it("validates what the model hands over", () => {
    expect(parseSchedule({ kind: "interval", hours: 6 })).toEqual({ kind: "interval", hours: 6 });
    expect(parseSchedule({ kind: "daily", hour: 9 })).toEqual({ kind: "daily", hour: 9, minute: 0 });
    expect(() => parseSchedule({ kind: "interval", hours: 0.5 })).toThrow(/whole number/);
    expect(() => parseSchedule({ kind: "daily", hour: 24 })).toThrow(/0–23/);
    expect(() => parseSchedule({ kind: "weekly" })).toThrow(/interval/);
  });

  it("interval keeps its rhythm from the anchor", () => {
    const anchor = at(2026, 10, 22, 9, 10);
    const s = { kind: "interval", hours: 6 } as const;
    expect(nextRunAfter(s, anchor + 1, anchor)).toBe(anchor + 6 * H);
    expect(nextRunAfter(s, anchor + 13 * H, anchor)).toBe(anchor + 18 * H);
    expect(latestSlotAtOrBefore(s, anchor + 5 * H, anchor)).toBeNull();
    expect(latestSlotAtOrBefore(s, anchor + 13 * H, anchor)).toBe(anchor + 12 * H);
  });

  it("daily runs at the local time, today or tomorrow", () => {
    const s = { kind: "daily", hour: 9, minute: 30 } as const;
    expect(nextRunAfter(s, at(2026, 10, 22, 8), 0)).toBe(at(2026, 10, 22, 9, 30));
    expect(nextRunAfter(s, at(2026, 10, 22, 10), 0)).toBe(at(2026, 10, 23, 9, 30));
    expect(latestSlotAtOrBefore(s, at(2026, 10, 22, 10), 0)).toBe(at(2026, 10, 22, 9, 30));
    expect(latestSlotAtOrBefore(s, at(2026, 10, 22, 8), 0)).toBe(at(2026, 10, 21, 9, 30));
  });

  it("describes itself for the list", () => {
    expect(describeSchedule({ kind: "interval", hours: 1 })).toBe("Every hour");
    expect(describeSchedule({ kind: "daily", hour: 7, minute: 5 })).toBe("Every day at 07:05");
  });
});

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covault-auto-"));
  return { dir, store: new AutomationStore({ fs, dir: () => dir, vaultKey: () => "v1" }) };
}

describe("AutomationStore", () => {
  it("persists automations and their run logs, newest run first", () => {
    const { dir, store } = tmpStore();
    const a = store.add({ name: "Digest", instructions: "Do it", schedule: { kind: "interval", hours: 2 } });
    store.appendRun(a.id, { at: 1, status: "ok", trigger: "manual", ms: 5, summary: "one", tools: [], changed: [] });
    store.appendRun(a.id, { at: 2, status: "error", trigger: "schedule", ms: 5, summary: "two", tools: [], changed: [] });

    const reopened = new AutomationStore({ fs, dir: () => dir, vaultKey: () => "v1" });
    expect(reopened.list().map((x) => x.name)).toEqual(["Digest"]);
    expect(reopened.runs(a.id).map((r) => r.summary)).toEqual(["two", "one"]);

    reopened.update(a.id, { enabled: false });
    expect(reopened.get(a.id)?.enabled).toBe(false);
    reopened.remove(a.id);
    expect(reopened.list()).toEqual([]);
    expect(reopened.runs(a.id)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps vaults apart", () => {
    const { dir, store } = tmpStore();
    store.add({ name: "A", instructions: "x", schedule: { kind: "daily", hour: 9, minute: 0 } });
    expect(new AutomationStore({ fs, dir: () => dir, vaultKey: () => "other" }).list()).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("applyEdits", () => {
  it("replaces exact, unique text in order", () => {
    expect(applyEdits("a b c", [{ oldText: "b", newText: "B" }, { oldText: "c", newText: "C" }])).toBe("a B C");
  });
  it("refuses a missing or ambiguous oldText", () => {
    expect(() => applyEdits("a b", [{ oldText: "z", newText: "" }])).toThrow(/not found/);
    expect(() => applyEdits("a a", [{ oldText: "a", newText: "" }])).toThrow(/more than once/);
  });
});

describe("AutomationRunner.tick", () => {
  function runner(store: AutomationStore) {
    return new AutomationRunner({
      store,
      // No model configured: a run that does start records an error, which
      // is all these tests need to tell "ran" from "skipped".
      model: { models: {} as never, getSelection: () => ({ provider: "", model: "" }), hasKey: () => false },
      notes: { vaultBase: () => "/", repos: () => [], writeNote: async () => undefined },
      repos: () => [],
      vaultName: () => "v",
      onNotesChanged: () => undefined,
      onChange: () => undefined,
    });
  }

  it("runs a slot that is due now, once", async () => {
    const { dir, store } = tmpStore();
    const a = store.add({ name: "Hourly", instructions: "x", schedule: { kind: "interval", hours: 1 } });
    const r = runner(store);
    const now = a.createdAt + H + 1000;
    r.tick(now);
    await r.runNow(a.id); // joins the queued run
    r.tick(now + 1000); // same slot: nothing new
    const runs = store.runs(a.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("error");
    expect(runs[0]!.summary).toMatch(/No AI model/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips a slot it is too late for, and says so in the log", () => {
    const { dir, store } = tmpStore();
    const a = store.add({ name: "Hourly", instructions: "x", schedule: { kind: "interval", hours: 1 } });
    const r = runner(store);
    r.tick(a.createdAt + 3 * H + LATE_GRACE_MS + 1000);
    const runs = store.runs(a.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("skipped");
    expect(store.get(a.id)?.lastSlotAt).toBe(a.createdAt + 3 * H);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves paused automations alone", () => {
    const { dir, store } = tmpStore();
    const a = store.add({ name: "Hourly", instructions: "x", schedule: { kind: "interval", hours: 1 } });
    store.update(a.id, { enabled: false });
    runner(store).tick(a.createdAt + 5 * H);
    expect(store.runs(a.id)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("a run end to end (scripted model)", () => {
  it("lets the agent write a note, then logs its report and the changed path", async () => {
    const { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
    // The runner's timeout uses window timers; vitest runs headless.
    (globalThis as { window?: unknown }).window ??= globalThis;

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_note", { path: "Digest/today.md", content: "# Today\n" })),
      fauxAssistantMessage("Wrote Digest/today.md."),
    ]);

    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "covault-vault-"));
    const { dir, store } = tmpStore();
    let synced = 0;
    const r = new AutomationRunner({
      store,
      model: { models, getSelection: () => ({ provider: model.provider, model: model.id }), hasKey: () => true },
      notes: {
        vaultBase: () => vault,
        repos: () => [],
        writeNote: async (p, content) => {
          fs.mkdirSync(path.dirname(path.join(vault, p)), { recursive: true });
          fs.writeFileSync(path.join(vault, p), content);
        },
      },
      repos: () => [],
      vaultName: () => "v",
      onNotesChanged: () => synced++,
      onChange: () => undefined,
    });
    const a = store.add({ name: "Digest", instructions: "Write today's digest.", schedule: { kind: "daily", hour: 9, minute: 0 } });
    await r.runNow(a.id);

    expect(fs.readFileSync(path.join(vault, "Digest/today.md"), "utf8")).toBe("# Today\n");
    const [run] = store.runs(a.id);
    expect(run).toMatchObject({ status: "ok", trigger: "manual", summary: "Wrote Digest/today.md.", changed: ["Digest/today.md"] });
    expect(run!.tools).toEqual([{ name: "write_note", summary: "Digest/today.md", isError: false }]);
    expect(synced).toBe(1); // the write is handed to the sync loop
    expect(store.get(a.id)?.lastRunAt).toBeTypeOf("number");

    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses paths in vault machinery", async () => {
    const { makeNoteTools } = await import("../src/automation/noteTools");
    const tools = makeNoteTools({ vaultBase: () => "/v", repos: () => [], writeNote: async () => undefined }, () => undefined);
    const write = tools.find((t) => t.name === "write_note")!;
    await expect(write.execute("1", { path: ".obsidian/x.md", content: "" })).rejects.toThrow(/machinery/);
    await expect(write.execute("1", { path: "../outside.md", content: "" })).rejects.toThrow(/outside/);
    await expect(write.execute("1", { path: "notes/x.txt", content: "" })).rejects.toThrow(/\.md/);
  });
});

describe("the setup conversation (scripted model)", () => {
  it("creates an automation through its tool and replies", async () => {
    const { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
    const { AutomationDesigner } = await import("../src/automation/designer");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("create_automation", {
          name: "Morning digest",
          instructions: "Summarize yesterday's changes into Daily/digest.md.",
          schedule: { kind: "daily", hour: 9 },
        }),
      ),
      fauxAssistantMessage("Done — it runs every day at 09:00."),
    ]);

    const { dir, store } = tmpStore();
    const modelDeps = { models, getSelection: () => ({ provider: model.provider, model: model.id }), hasKey: () => true };
    const notes = { vaultBase: () => "/v", repos: () => [], writeNote: async () => undefined };
    const runner = new AutomationRunner({
      store,
      model: modelDeps,
      notes,
      repos: () => [],
      vaultName: () => "v",
      onNotesChanged: () => undefined,
      onChange: () => undefined,
    });
    let changes = 0;
    const designer = new AutomationDesigner({ store, runner, model: modelDeps, notes, vaultName: () => "v", onChange: () => changes++ });

    const reply = await designer.send("每天早上 9 点把昨天的改动汇总一下");
    expect(reply).toBe("Done — it runs every day at 09:00.");
    expect(store.list()).toMatchObject([
      { name: "Morning digest", schedule: { kind: "daily", hour: 9, minute: 0 }, enabled: true },
    ]);
    expect(changes).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

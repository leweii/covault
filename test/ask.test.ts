import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type MutableModels, type ToolCall } from "@earendil-works/pi-ai";
import { searchLibraries, readLibraryNote } from "../src/covault/librarySearch";
import { makeJobTools, makeReadTool, makeRunCommandTool, makeSearchTool } from "../src/llm/agentTools";
import { BackgroundJobs, type BackgroundJob } from "../src/llm/backgroundJobs";
import { parseMcpConfig } from "../src/llm/mcp";
import { AskEngine, type AskDeps } from "../src/llm/ask";
import { loadAskSkills } from "../src/llm/skills";
import type { ManifestRepo } from "../src/covault/manifest";

let vault: string;
const repos = (): ManifestRepo[] => [
  { path: "teams/ccp-kb", url: "https://github.com/ct-kb/ccp-kb.git", branch: "main" },
  { path: "teams/oms-kb", url: "https://github.com/ct-kb/oms-kb.git", branch: "main" },
];
const libraryDeps = { vaultBase: () => vault, repos };

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
  it("searches the whole vault: libraries and personal notes alike", () => {
    const hits = searchLibraries(vault, repos(), "refund zendesk");
    expect(hits[0]?.path).toBe("teams/ccp-kb/02_domain/refunds.md");
    expect(hits[0]?.lines.join(" ")).toContain("Zendesk");
    // Personal notes are in scope now — the user's vault, the user's call.
    expect(hits.some((h) => h.path === "private/diary.md")).toBe(true);
    // Machinery never is.
    fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
    fs.writeFileSync(path.join(vault, ".obsidian", "workspace.md"), "refund refund\n");
    expect(searchLibraries(vault, repos(), "refund").some((h) => h.path.includes(".obsidian"))).toBe(false);
  });

  it("restricts to one library by name or path", () => {
    expect(searchLibraries(vault, repos(), "refund", "oms-kb")).toHaveLength(0);
    expect(searchLibraries(vault, repos(), "cancel", "teams/oms-kb")[0]?.path).toBe("teams/oms-kb/cancel.md");
  });
});

describe("readLibraryNote", () => {
  it("reads any vault note, refusing machinery and escapes", () => {
    expect(readLibraryNote(vault, repos(), "teams/ccp-kb/02_domain/refunds.md")).toContain("Zendesk");
    expect(readLibraryNote(vault, repos(), "private/diary.md")).toContain("secret");
    expect(readLibraryNote(vault, repos(), "../outside.md")).toBeNull();
    expect(readLibraryNote(vault, repos(), ".obsidian/workspace.json")).toBeNull();
    expect(readLibraryNote(vault, repos(), "teams/ccp-kb/../../../etc/hosts")).toBeNull();
  });
});

describe("run_command tool", () => {
  it("always demands approval and runs in the vault directory", async () => {
    const tool = makeRunCommandTool(() => vault);
    expect(tool.needsApproval?.({ command: "ls" })).toEqual({ action: "$ ls" });
    const outcome = await tool.execute({ command: "ls teams" });
    expect(outcome.isError).toBeFalsy();
    expect(outcome.text).toContain("ccp-kb");
  });

  it("reports failure with the exit code", async () => {
    const tool = makeRunCommandTool(() => vault);
    const outcome = await tool.execute({ command: "exit 3" });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("exit code 3");
  });
});

describe("parseMcpConfig", () => {
  it("accepts the Claude Desktop shape and plain arrays", () => {
    const a = parseMcpConfig('{"mcpServers": {"jira": {"command": "npx", "args": ["x"]}}}');
    expect(a).toEqual([{ name: "jira", command: "npx", args: ["x"] }]);
    const b = parseMcpConfig('[{"name": "docs", "url": "https://mcp.example.com"}]');
    expect(b[0]?.url).toBe("https://mcp.example.com");
    expect(parseMcpConfig("")).toEqual([]);
  });

  it("rejects invalid JSON with a readable error and drops transportless entries", () => {
    expect(() => parseMcpConfig("{nope")).toThrow(/not valid JSON/);
    expect(parseMcpConfig('{"mcpServers": {"broken": {}}}')).toEqual([]);
  });
});

// ── AskEngine on the native pi Agent, with a scripted streamFn ──────

type Script = AssistantMessage["content"][];

/** `seen` collects the requests, for tests that assert on the prompt. */
function scriptedModels(script: Script, seen?: { systemPrompt?: string }[]): MutableModels {
  let call = 0;
  return {
    getModel: () => ({ id: "fake", api: "fake", provider: "fake" }),
    streamSimple: (_model: unknown, context: { systemPrompt?: string }) => {
      seen?.push(context);
      const stream = createAssistantMessageEventStream();
      const content = script[Math.min(call++, script.length - 1)]!;
      const message: AssistantMessage = {
        role: "assistant",
        content,
        api: "fake" as never,
        provider: "fake",
        model: "fake",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } as never,
        stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
        timestamp: 0,
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        for (const [i, c] of content.entries()) {
          if (c.type === "text") {
            // Two deltas so the UI sees the text grow.
            const half = Math.ceil(c.text.length / 2);
            stream.push({ type: "text_delta", contentIndex: i, delta: c.text.slice(0, half), partial: message });
            stream.push({ type: "text_delta", contentIndex: i, delta: c.text.slice(half), partial: message });
          }
        }
        stream.push({ type: "done", reason: message.stopReason as never, message });
      });
      return stream;
    },
  } as unknown as MutableModels;
}

function engine(
  models: MutableModels,
  opts: { requireApproval?: boolean; jobs?: BackgroundJobs; skills?: AskDeps["skills"] } = {},
): AskEngine {
  return new AskEngine({
    models,
    getSelection: () => ({ provider: "fake", model: "fake" }),
    hasKey: () => true,
    requireApproval: () => opts.requireApproval ?? true,
    jobs: opts.jobs,
    tools: async () => [
      makeSearchTool(libraryDeps),
      makeReadTool(libraryDeps),
      makeRunCommandTool(() => vault, undefined, opts.jobs),
      ...(opts.jobs ? makeJobTools(opts.jobs) : []),
    ],
    libraryMap: () => "## ccp-kb — refunds, Zendesk\n## oms-kb — order cancellation",
    skills: opts.skills,
  });
}

const toolCall = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

describe("AskEngine", () => {
  it("streams the answer and reports tool activity", async () => {
    const ask = engine(
      scriptedModels([
        [toolCall("1", "search_notes", { query: "refund" })],
        [toolCall("2", "read_note", { path: "teams/ccp-kb/02_domain/refunds.md" })],
        [{ type: "text", text: "Refunds go through Zendesk first.\n\nSources: [[teams/ccp-kb/02_domain/refunds.md]]" }],
      ]),
    );
    const deltas: string[] = [];
    const activity: string[] = [];
    const answer = await ask.ask("退款流程是怎样的？", {
      onDelta: (t) => deltas.push(t),
      onActivity: (l) => activity.push(l),
    });
    expect(answer.text).toContain("Zendesk");
    expect(answer.toolCalls).toBe(2);
    expect(activity[0]).toContain("Searching");
    expect(activity[1]).toContain("Reading refunds.md");
    // Streaming: an early delta is a strict prefix of the final text.
    expect(deltas.length).toBeGreaterThan(1);
    expect(answer.text.startsWith(deltas[0]!.slice(0, 10))).toBe(true);
  });

  it("blocks gated tools unless the user approves", async () => {
    const script: Script = [
      [toolCall("1", "run_command", { command: "ls teams" })],
      [{ type: "text", text: "done" }],
    ];
    const denied = engine(scriptedModels(script));
    const answer = await denied.ask("list", { approve: async () => false });
    expect(answer.text).toBe("done");
    // The command never ran: nothing was approved.

    const asked: string[] = [];
    const allowed = engine(scriptedModels(script));
    await allowed.ask("list", {
      approve: async (request) => {
        asked.push(request.action);
        return true;
      },
    });
    expect(asked).toEqual(["$ ls teams"]);
  });

  it("skip-permissions mode runs gated tools without asking, but boundaries hold", async () => {
    const script: Script = [
      [toolCall("1", "run_command", { command: "ls teams" })],
      [{ type: "text", text: "done" }],
    ];
    let askedCount = 0;
    const yolo = engine(scriptedModels(script), { requireApproval: false });
    const answer = await yolo.ask("list", {
      approve: async () => {
        askedCount += 1;
        return false;
      },
    });
    expect(answer.text).toBe("done");
    expect(askedCount).toBe(0); // ran without asking

    // The vault boundary is not a permission — it still rejects.
    const { makeEditTools } = await import("../src/llm/editTools");
    const escape = new AskEngine({
      models: scriptedModels([
        [toolCall("1", "edit_note", { path: "../evil.md", edits: [{ oldText: "a", newText: "b" }] })],
        [{ type: "text", text: "blocked, done" }],
      ]),
      getSelection: () => ({ provider: "fake", model: "fake" }),
      hasKey: () => true,
      requireApproval: () => false,
      tools: async () => makeEditTools({ vaultBase: () => vault, repos, onMutation: () => {} }),
      libraryMap: () => null,
    });
    const a2 = await escape.ask("edit outside");
    expect(a2.text).toBe("blocked, done");
    expect(fs.existsSync(path.join(vault, "..", "evil.md"))).toBe(false);
  });

  it("advertises the skills on disk and loads one on demand", async () => {
    const dir = path.join(vault, ".claude/skills/refunds");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: refunds\ndescription: How this team answers refund questions.\n---\n\nAlways name the OMS ticket.\n",
    );

    const seen: { systemPrompt?: string }[] = [];
    const ask = engine(
      scriptedModels(
        [[toolCall("1", "load_skill", { name: "refunds" })], [{ type: "text", text: "done" }]],
        seen,
      ),
      { skills: () => loadAskSkills(vault) },
    );
    const activity: string[] = [];
    const answer = await ask.ask("退款怎么答？", { onActivity: (l) => activity.push(l) });

    expect(answer.text).toBe("done");
    // Listed by description only; the body arrives through the tool.
    expect(seen[0]?.systemPrompt).toContain("<name>refunds</name>");
    expect(seen[0]?.systemPrompt).not.toContain("Always name the OMS ticket.");
    expect(activity.join(" ")).toContain("Loading the refunds skill");
    expect(answer.toolCalls).toBe(1);
  });

  /**
   * Reproduces the layering that made a failed request unactionable: pi-ai
   * turns a thrown fetch into an `error` event carrying only
   * `error.message`, and the Anthropic SDK's message is "Connection error."
   * The engine must still name the cause, which it can only do because it
   * supplied the fetch.
   */
  it("names why a request never reached the model", async () => {
    const models = {
      getModel: () => ({ id: "fake", api: "fake", provider: "fake", input: ["text"] }),
      streamSimple: (_m: unknown, _c: unknown, options: { fetch?: typeof globalThis.fetch }) => {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          const message: AssistantMessage = {
            role: "assistant",
            content: [],
            api: "fake" as never,
            provider: "fake",
            model: "fake",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } as never,
            stopReason: "error",
            timestamp: 0,
          };
          try {
            await options.fetch!("https://api.anthropic.com/v1/messages");
          } catch {
            // Exactly what pi-ai does: the cause is dropped here.
            message.errorMessage = "Connection error.";
          }
          stream.push({ type: "error", reason: "error", error: message } as never);
          stream.end();
        })();
        return stream;
      },
    } as unknown as MutableModels;

    const lines: string[] = [];
    const ask = new AskEngine({
      models,
      getSelection: () => ({ provider: "fake", model: "fake" }),
      hasKey: () => true,
      requireApproval: () => true,
      tools: async () => [],
      libraryMap: () => null,
      onTransport: (line) => lines.push(line),
    });

    // The renderer's fetch is what fails on a machine behind a proxy, and
    // window.fetch is what the transport reaches for — so that is what has
    // to fail here. No window exists in this environment; stand one up.
    const host = globalThis as { window?: { fetch: unknown } };
    const realWindow = host.window;
    host.window = {
      fetch: async () => {
        throw new Error("fetch failed", { cause: new Error("unable to verify the first certificate") });
      },
    };
    try {
      await expect(ask.ask("anything")).rejects.toThrow(/first certificate/);
    } finally {
      if (realWindow) host.window = realWindow;
      else delete host.window;
    }
    expect(lines.some((l) => l.includes("FAILED api.anthropic.com/v1/messages"))).toBe(true);
  });

  it("keeps the conversation until reset", async () => {
    const ask = engine(scriptedModels([[{ type: "text", text: "answer" }]]));
    await ask.ask("q1");
    await ask.ask("q2");
    ask.reset();
    const a = await ask.ask("q3");
    expect(a.text).toBe("answer");
  });

  it("round-trips the transcript through save and restore", async () => {
    const first = engine(scriptedModels([[{ type: "text", text: "answer one" }]]));
    await first.ask("q1");
    const saved = first.getTranscript();
    expect(saved.length).toBe(2); // user + assistant
    // A different engine (fresh view, later day) resumes the context.
    const second = engine(scriptedModels([[{ type: "text", text: "answer two" }]]));
    second.setTranscript(saved);
    await second.ask("q2");
    const transcript = second.getTranscript();
    expect(transcript.length).toBe(4);
    expect(JSON.stringify(transcript)).toContain("answer one");
  });
});

describe("edit tools through the agent", () => {
  it("previews a diff, requires fresh approval, edits the note, and pokes sync", async () => {
    const { makeEditTools } = await import("../src/llm/editTools");
    let mutations = 0;
    const tools = makeEditTools({ vaultBase: () => vault, repos, onMutation: () => (mutations += 1) });
    const edit = tools.find((t) => t.name === "edit_note")!;

    const req = edit.needsApproval!({
      path: "teams/ccp-kb/02_domain/refunds.md",
      edits: [{ oldText: "Zendesk first", newText: "Zendesk FIRST (always)" }],
    })!;
    expect(req.action).toBe("Edit teams/ccp-kb/02_domain/refunds.md");
    expect(req.diff).toContain("-Refunds go through Zendesk first");
    expect(req.diff).toContain("+Refunds go through Zendesk FIRST (always)");

    const outcome = await edit.execute({
      path: "teams/ccp-kb/02_domain/refunds.md",
      edits: [{ oldText: "Zendesk first", newText: "Zendesk FIRST (always)" }],
    });
    expect(outcome.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(vault, "teams/ccp-kb/02_domain/refunds.md"), "utf8")).toContain("FIRST (always)");
    expect(mutations).toBe(1);
  });

  it("edits personal notes too, but never machinery or escapes", async () => {
    const { makeEditTools } = await import("../src/llm/editTools");
    const tools = makeEditTools({ vaultBase: () => vault, repos, onMutation: () => {} });
    const edit = tools.find((t) => t.name === "edit_note")!;
    const req = edit.needsApproval!({ path: "private/diary.md", edits: [{ oldText: "secret", newText: "open" }] })!;
    expect(req.action).toBe("Edit private/diary.md");
    const write = tools.find((t) => t.name === "write_note")!;
    expect(() => write.needsApproval!({ path: "../evil.md", content: "x" })).toThrow(/outside/);
    expect(() => write.needsApproval!({ path: ".covault/covault.json", content: "x" })).toThrow(/outside/);
  });

  it("write_note distinguishes create from replace in the approval", async () => {
    const { makeEditTools } = await import("../src/llm/editTools");
    const tools = makeEditTools({ vaultBase: () => vault, repos, onMutation: () => {} });
    const write = tools.find((t) => t.name === "write_note")!;
    const fresh = write.needsApproval!({ path: "teams/oms-kb/new-runbook.md", content: "# Runbook\n" })!;
    expect(fresh.action).toBe("Create teams/oms-kb/new-runbook.md");
    expect(fresh.diff).toContain("+# Runbook");
    const replace = write.needsApproval!({ path: "teams/oms-kb/cancel.md", content: "# New\n" })!;
    expect(replace.action).toBe("Replace teams/oms-kb/cancel.md");
  });

  it("a blocked edit never touches the file", async () => {
    const { makeEditTools } = await import("../src/llm/editTools");
    const ask = new AskEngine({
      models: scriptedModels([
        [toolCall("1", "edit_note", { path: "teams/oms-kb/cancel.md", edits: [{ oldText: "OMS console", newText: "NEW console" }] })],
        [{ type: "text", text: "declined, done" }],
      ]),
      getSelection: () => ({ provider: "fake", model: "fake" }),
      hasKey: () => true,
      requireApproval: () => true,
      tools: async () => makeEditTools({ vaultBase: () => vault, repos, onMutation: () => {} }),
      libraryMap: () => null,
    });
    const seen: string[] = [];
    await ask.ask("edit it", {
      approve: async (r) => {
        seen.push(r.diff ?? "");
        return false;
      },
    });
    expect(seen[0]).toContain("+Use the NEW console");
    expect(fs.readFileSync(path.join(vault, "teams/oms-kb/cancel.md"), "utf8")).toContain("OMS console");
  });
});

describe("background commands", () => {
  let jobs: BackgroundJobs;
  beforeEach(() => {
    jobs = new BackgroundJobs({ cwd: () => vault, logDir: () => path.join(vault, ".logs") });
  });
  afterEach(() => jobs.dispose());

  it("collects output and reports the exit through the callback", async () => {
    const finished = new Promise<BackgroundJob>((resolve) => jobs.onFinished(resolve));
    const job = jobs.start("echo hello; exit 3");
    expect(job.status).toBe("running");
    expect(jobs.running()).toHaveLength(1);

    const ended = await finished;
    expect(ended.id).toBe(job.id);
    expect(ended.status).toBe("failed");
    expect(ended.exitCode).toBe(3);
    expect(jobs.tail(job.id)).toContain("hello");
    expect(jobs.running()).toHaveLength(0);
  });

  it("stops a job on request", async () => {
    const finished = new Promise<BackgroundJob>((resolve) => jobs.onFinished(resolve));
    const job = jobs.start("sleep 30");
    expect(jobs.stop(job.id)).toBe(true);
    const ended = await finished;
    expect(ended.signal).toBe("SIGTERM");
    expect(jobs.running()).toHaveLength(0);
  });

  it("returns from the tool at once instead of waiting", async () => {
    const tool = makeRunCommandTool(() => vault, undefined, jobs);
    // The point of the flag: a command far longer than the foreground
    // timeout answers in milliseconds.
    const outcome = await tool.execute({ command: "sleep 30", run_in_background: true });
    expect(outcome.isError).toBeFalsy();
    expect(outcome.text).toMatch(/Started bg1 in the background/);
    expect(tool.needsApproval?.({ command: "sleep 30", run_in_background: true })).toEqual({
      action: "$ sleep 30  (in the background)",
    });
    expect(jobs.running()).toHaveLength(1);
  });

  it("tells the model the flag exists, where it will look for it", async () => {
    // The 30s foreground timeout is only survivable if the description
    // names the way out; without a registry there is nothing to offer.
    expect(makeRunCommandTool(() => vault, undefined, jobs).description).toContain("run_in_background: true");
    expect(makeRunCommandTool(() => vault).description).not.toContain("run_in_background");
  });

  /**
   * The whole reason the mechanism exists: the turn ends while the work
   * goes on, and the job finishing is what brings the conversation back.
   */
  it("wakes the conversation when a job finishes between turns", async () => {
    const ask = engine(
      scriptedModels([
        [toolCall("1", "run_command", { command: "sleep 0.3; echo pipeline-done", run_in_background: true })],
        [{ type: "text", text: "Started it — I'll report back when it exits." }],
        [{ type: "text", text: "It finished: pipeline-done." }],
      ]),
      { jobs },
    );
    const woken: string[] = [];
    ask.onWake = (note) => void woken.push(note);

    const first = await ask.ask("run the pipeline", { approve: async () => true });
    expect(first.text).toContain("report back");
    expect(ask.runningJobs()).toHaveLength(1);

    await vi.waitFor(() => expect(woken).toHaveLength(1));
    expect(woken[0]).toContain("[background]");
    expect(woken[0]).toContain("exit code 0");
    expect(woken[0]).toContain("pipeline-done");

    // The note is a prompt like any other — the conversation carries on.
    const second = await ask.ask(woken[0]!, {});
    expect(second.text).toContain("It finished");
  });

  /**
   * A job that lands while the agent is still working must not open a
   * second turn underneath it: pi-agent-core's steering queue is drained
   * at the next turn boundary, so the running loop absorbs it.
   */
  it("steers a job that lands mid-turn into the run in flight", async () => {
    const ask = engine(
      scriptedModels([
        [toolCall("1", "run_command", { command: "echo first", run_in_background: true })],
        [{ type: "text", text: "All done." }],
      ]),
      { jobs },
    );
    const woken: string[] = [];
    ask.onWake = (note) => void woken.push(note);

    // The approval gate is the pause: the run is in flight and stays
    // there until we allow the command.
    let release = () => {};
    const paused = new Promise<void>((resolve) => (release = resolve));
    const answer = ask.ask("start it", {
      approve: async () => {
        // Something started earlier finishes while the turn is stuck here.
        const finished = new Promise<BackgroundJob>((resolve) => jobs.onFinished(resolve));
        jobs.start("echo earlier-job");
        await finished;
        await paused;
        return true;
      },
    });
    release();
    await answer;

    expect(woken).toHaveLength(0); // no second turn was opened
    const transcript = ask.getTranscript();
    const notes = transcript.filter(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[background]"),
    );
    expect(notes).toHaveLength(1);
    expect(String(notes[0]?.content)).toContain("earlier-job");
  });
});

describe("the turn budget", () => {
  /**
   * The runaway it exists to catch: a model that keeps calling tools and
   * never answers. Stopping must not cost the reader what was written —
   * the loop is asked to stop after a completed turn rather than aborted
   * in the middle of one.
   */
  it("stops after a completed turn and keeps what the model wrote", async () => {
    const ask = engine(
      scriptedModels([
        // The last entry repeats forever: search, search, search…
        [{ type: "text", text: "Still looking through the libraries." }, toolCall("1", "search_notes", { query: "refund" })],
      ]),
    );
    const answer = await ask.ask("dig until you drop");
    expect(answer.text).toContain("Still looking through the libraries.");
    expect(answer.text).toContain("Stopped after 16 steps");
    expect(answer.toolCalls).toBe(16);
    // Stopped, not aborted: the transcript is intact and usable.
    expect(ask.getTranscript().length).toBeGreaterThan(16);
  });

  it("reports a runaway that never wrote anything as an error", async () => {
    const ask = engine(scriptedModels([[toolCall("1", "search_notes", { query: "refund" })]]));
    await expect(ask.ask("dig silently")).rejects.toThrow(/Stopped after 16 steps/);
  });
});

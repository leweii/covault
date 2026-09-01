/**
 * Ask: answer questions from the team knowledge libraries — and, when the
 * user allows it, act with tools — inside the plugin.
 *
 * Built on pi-agent-core's Agent (the pi SDK's native loop): it owns the
 * transcript, streams assistant text as it is generated, executes tools,
 * and exposes the beforeToolCall hook this engine uses as its approval
 * gate — a tool whose needsApproval() returns an action string only runs
 * after the UI confirms that exact action with the user.
 *
 * The model gets the library map (which library covers what) in its
 * system prompt, plus the inventory of command-line tools actually
 * installed on this machine — a shell it doesn't know the contents of is
 * a shell it never uses — plus the Agent Skills this machine's coding
 * agents already have (skills.ts). The tool surface is assembled by the
 * plugin: library search/read always, shell, skills and MCP tools per
 * settings and what's on disk.
 */
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  contentText,
  type ImageContent,
  type Message,
  type MutableModels,
} from "@earendil-works/pi-ai";
import type { ApprovalRequest, AskTool } from "./agentTools";
import { describeJob, type BackgroundJob, type BackgroundJobs } from "./backgroundJobs";
import type { AskSkills } from "./skills";
import { createTransportProbe, describeError, type DiagnoseFn, type TransportProbe } from "./transport";

/** Runaway guard: a stretch of uninterrupted work should never burn more
 *  turns than this. Reset whenever a background job wakes the agent —
 *  waiting for a ten-minute build is not a runaway, and the budget is
 *  there to stop a loop, not to put a clock on the task.
 *
 *  Enforced through the loop's own shouldStopAfterTurn hook rather than
 *  by aborting: the turn that hits the ceiling finishes normally, so
 *  what the model had already written survives the stop. */
const MAX_TURNS = 16;

const SYSTEM_PROMPT = `You answer questions using the notes in this vault: the team's shared knowledge libraries (the map below tells you which library covers which topics) and the user's own personal notes (everything outside the library folders — not mapped, just search them).

Rules:
- ALWAYS look before you answer: pick the likely library from the map (or search the whole vault when the question sounds personal), call search_notes, read the most promising notes with read_note. The notes are the source of truth; your general knowledge is only for interpreting them.
- If the notes don't answer the question, say so plainly — never invent an answer that isn't in the libraries.
- Other tools (shell commands, connected services) may be available; use them when they genuinely help answer or complete what was asked. The inventory below lists the command-line tools installed on this machine — consult it before concluding you can't reach some data or system. The user approves risky actions individually — a declined action is an answer, not an obstacle: work with what you have.
- Waiting is not your job. Anything that could take more than half a minute goes to run_command with run_in_background: true; then end your turn with one line saying what is running and what you'll do with the result. The moment it exits you are woken with its output and pick up exactly where you left off. Never sleep, never poll a log in a loop — that spends the conversation on waiting and leaves nothing for the work.
- When the user asks you to update, fix or add to the team's notes, do it with edit_note (targeted oldText → newText replacements; prefer it) or write_note (new notes). Keep each note's existing language, style and structure; make the smallest change that fulfils the request. The user reviews a diff before anything is written.
- Answer in the language the question was asked in.
- Keep answers focused; quote concrete facts (names, values, steps) from the notes.
- End with a "Sources:" line listing every note you used, each as an Obsidian wiki link: [[path/to/note.md]] (the vault-relative path you saw in tool results).`;

export interface AskCallbacks {
  signal?: AbortSignal;
  /** Streaming text of the answer being written, cumulative. */
  onDelta?: (answerSoFar: string) => void;
  /** One line per agent action ("Searching ccp-kb…", "$ git log…"). */
  onActivity?: (line: string) => void;
  /** Ask the user to allow an action. Absent → everything gated is denied. */
  approve?: (request: ApprovalRequest) => Promise<boolean>;
}

export interface AskAnswer {
  text: string;
  toolCalls: number;
}

export interface AskDeps {
  models: MutableModels;
  getSelection: () => { provider: string; model: string };
  hasKey: (provider: string) => boolean;
  /** false = dangerously-skip-permissions: gated tools run without asking.
   *  Boundary rejections (paths outside the vault) still apply. */
  requireApproval: () => boolean;
  /** Full tool surface for a new question (settings may change between asks). */
  tools: () => Promise<AskTool[]>;
  /** The library map: which library covers what, built from what is on
   *  disk right now. null when there is nothing to map. */
  libraryMap: () => string | null;
  /** Agent Skills found on disk, or null when the vault and the user
   *  have none. Resolved per question, like the tools: a skill written
   *  mid-conversation is available to the next question. */
  skills?: () => Promise<AskSkills | null>;
  /** The installed-CLI block for the system prompt, or null when there is
   *  nothing to advertise. Resolved per question, so a tool installed
   *  mid-session shows up after a refresh. */
  cliManifest?: () => Promise<string | null>;
  /** Commands this conversation has running in the background. The engine
   *  subscribes to it: a job ending is what wakes the agent back up. */
  jobs?: BackgroundJobs;
  /** One line per model HTTP request, for the debug log. `failed` marks the
   *  ones worth recording even when debug mode is off. */
  onTransport?: (line: string, failed: boolean) => void;
  /** Asks the endpoint what it really said when a request failed; see
   *  transport.ts. Without it a CORS-hidden status stays hidden. */
  diagnose?: DiagnoseFn;
}

/**
 * Transcript with image bytes swapped for a placeholder, for saving.
 *
 * The live agent keeps the real parts, so follow-ups in the open
 * conversation still see the screenshot; what gets written to disk does
 * not, because a resumed session would otherwise re-send megabytes of
 * base64 forever and bloat chats.json. The view still shows the thumbnail
 * from the AttachmentStore, so the loss is the model's memory of the
 * pixels — not the user's record of them.
 */
export function withoutImageData(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (typeof message.content === "string" || !Array.isArray(message.content)) return message;
    if (!message.content.some((part) => part.type === "image")) return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "image" ? { type: "text" as const, text: "[image omitted from the saved transcript]" } : part,
      ),
    } as Message;
  });
}

/**
 * The failure the agent reported, plus what the transport actually saw.
 *
 * "Connection error." on its own tells the user nothing they can act on;
 * the probe's line names the proxy, the certificate or the refused host.
 * Only appended when the transport genuinely failed, so a rejected API key
 * or a model-side error keeps reading as itself.
 */
export function explainAskError(reported: string, transportFailure: string | null): string {
  if (!transportFailure) return reported;
  if (reported.includes(transportFailure)) return reported;
  return `${reported.replace(/\.$/, "")} — the request never reached the model: ${transportFailure}`;
}

/**
 * What a finished background job says to the agent that started it.
 *
 * Written as something the model can act on without going back to the
 * shell: the verdict, the command it came from, and the tail of the
 * output, with the log path for the parts that didn't fit.
 */
export function wakeNote(job: BackgroundJob, tail: string): string {
  return [
    `[background] ${describeJob(job)}.`,
    `$ ${job.command}`,
    `Output (tail; full log at ${job.logPath}):`,
    tail || "(no output)",
    "Carry on with what you were doing — the user has not said anything new.",
  ].join("\n");
}

export class AskEngine {
  private agent: Agent | null = null;
  private byName = new Map<string, AskTool>();
  private cb: AskCallbacks = {};
  /** Transcript restored from a saved session, applied on next ask. */
  private pendingHistory: Message[] | null = null;
  private probe: TransportProbe;
  /** True between the start and the end of a run — decides whether a
   *  wake-up can be steered into the turn in flight or needs a new one. */
  private busy = false;
  /** Turns spent in the current stretch of work; see MAX_TURNS. */
  private turns = 0;
  private unsubscribeJobs: (() => void) | null = null;

  /**
   * Called when a background job finishes and there is no turn running
   * to absorb the news. The view answers it by starting a turn with the
   * note as its prompt — the wake-up the agent has been promised.
   */
  onWake?: (note: string, job: BackgroundJob) => void;

  constructor(private deps: AskDeps) {
    this.probe = createTransportProbe(
      (line, failed) => this.deps.onTransport?.(line, failed),
      undefined,
      (url) => this.deps.diagnose?.(url) ?? Promise.resolve(null),
    );
    this.unsubscribeJobs = deps.jobs?.onFinished((job) => this.wake(job)) ?? null;
  }

  /**
   * Deliver a finished job to the conversation.
   *
   * Mid-run the note is steered in: pi-agent-core drains the steering
   * queue at every turn boundary, and an inner loop that would otherwise
   * stop keeps going while that queue has something in it — so the agent
   * absorbs the result without a second request being started underneath
   * it. Between runs there is no loop to steer, so the view is asked to
   * open a turn instead. Which of the two it is has to be decided here,
   * once: firing both would answer the same job twice.
   */
  private wake(job: BackgroundJob): void {
    const note = wakeNote(job, this.deps.jobs?.tail(job.id) ?? "");
    if (this.busy && this.agent) {
      // Real work arriving is the opposite of a runaway: the budget that
      // was there to catch a poll loop starts over.
      this.turns = 0;
      this.agent.steer({ role: "user", content: note, timestamp: Date.now() });
      this.cb.onActivity?.(`${describeJob(job)} — picking it back up…`);
      return;
    }
    this.onWake?.(note, job);
  }

  isEnabled(): boolean {
    const { provider, model } = this.deps.getSelection();
    return !!provider && !!model && this.deps.hasKey(provider);
  }

  /**
   * Can the selected model read images? pi-ai's registry declares this per
   * model (`input`), so the composer can offer attaching only when it will
   * actually be looked at.
   */
  supportsImages(): boolean {
    const { provider, model: modelId } = this.deps.getSelection();
    if (!provider || !modelId) return false;
    return this.deps.models.getModel(provider, modelId)?.input.includes("image") ?? false;
  }

  /** Drop the conversation; the next ask starts fresh. Background work
   *  belonged to the conversation being dropped, so it goes with it —
   *  nothing should be left running that has nobody to report to. */
  reset(): void {
    this.agent?.abort();
    this.agent = null;
    this.pendingHistory = null;
    // stopAll, not dispose: the next conversation in this view starts its
    // own jobs, and the engine is still the one listening for them.
    this.deps.jobs?.stopAll();
  }

  /** The conversation is over for good (the view is closing). */
  dispose(): void {
    this.unsubscribeJobs?.();
    this.unsubscribeJobs = null;
    this.onWake = undefined;
    this.agent?.abort();
    this.agent = null;
    this.pendingHistory = null;
    this.deps.jobs?.dispose();
  }

  /** Commands still running in the background, for the status line. */
  runningJobs(): BackgroundJob[] {
    return this.deps.jobs?.running() ?? [];
  }

  /** The conversation so far — persisted with the session. */
  getTranscript(): Message[] {
    return (this.agent?.state.messages as Message[] | undefined) ?? this.pendingHistory ?? [];
  }

  /** Restore a saved conversation; the next ask continues it. */
  setTranscript(messages: Message[]): void {
    this.agent?.abort();
    this.agent = null;
    this.pendingHistory = messages;
  }

  private toAgentTool(tool: AskTool): AgentTool {
    return {
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: async (_id, params, signal) => {
        const outcome = await tool.execute((params ?? {}) as Record<string, unknown>, signal);
        return {
          content: [{ type: "text", text: outcome.isError ? `ERROR: ${outcome.text}` : outcome.text }],
          details: outcome,
        };
      },
    } as AgentTool;
  }

  private buildAgent(): Agent {
    const agent = new Agent({
      // Our own fetch goes in so a failed request keeps its cause; see
      // transport.ts. streamSimple can also throw outright (missing key),
      // which the agent loop would report without context.
      streamFn: (model, context, options) => {
        try {
          return this.deps.models.streamSimple(model, context, { ...options, fetch: this.probe.fetch });
        } catch (e) {
          throw new Error(describeError(e));
        }
      },
      // The budget, applied where the loop offers to stop by itself:
      // after a completed turn, before the next provider request. An
      // abort here would kill the request mid-flight and take the
      // half-written answer with it.
      shouldStopAfterTurn: () => this.turns >= MAX_TURNS,
      beforeToolCall: async (ctx) => {
        const tool = this.byName.get(ctx.toolCall.name);
        let request: ApprovalRequest | null | undefined;
        try {
          request = tool?.needsApproval?.((ctx.args ?? {}) as Record<string, unknown>);
        } catch (e) {
          // The gate itself rejected the call (bad path, missing note…).
          return { block: true, reason: (e as Error).message };
        }
        if (!request) return undefined;
        if (!this.deps.requireApproval()) return undefined; // user opted out of prompts
        const allowed = (await this.cb.approve?.(request)) ?? false;
        return allowed ? undefined : { block: true, reason: "The user declined this action. Continue without it." };
      },
    });
    return agent;
  }

  /** Ask a question; resolves with the final answer once the agent stops. */
  async ask(question: string, cb: AskCallbacks = {}, images: ImageContent[] = []): Promise<AskAnswer> {
    const { provider, model: modelId } = this.deps.getSelection();
    const model = this.deps.models.getModel(provider, modelId);
    if (!model) throw new Error(`Model ${provider}/${modelId} is not available — pick one in Settings.`);
    // pi-ai drops image parts on a text-only model without a word, which
    // reads as the model ignoring the screenshot. Say so instead.
    if (images.length > 0 && !model.input.includes("image")) {
      throw new Error(`${model.name} can't read images — pick a model with vision in Settings to send screenshots.`);
    }

    // All three are per-question: settings, MCP config, the installed
    // CLIs and the skills on disk can all change between asks. Resolved
    // together so none waits on another, and as one snapshot — the
    // prompt lists exactly the skills load_skill can open.
    const [ownTools, cliManifest, skills] = await Promise.all([
      this.deps.tools(),
      this.deps.cliManifest?.() ?? null,
      this.deps.skills?.() ?? null,
    ]);
    const tools = skills ? [...ownTools, ...skills.tools] : ownTools;
    this.byName = new Map(tools.map((t) => [t.name, t]));
    this.cb = cb;

    if (!this.agent) {
      this.agent = this.buildAgent();
      if (this.pendingHistory) {
        this.agent.state.messages = this.pendingHistory;
        this.pendingHistory = null;
      }
    }
    const agent = this.agent;
    const map = this.deps.libraryMap();
    const sections = [SYSTEM_PROMPT];
    if (map) sections.push(`=== Library map ===\n${map}`);
    if (cliManifest) sections.push(cliManifest);
    if (skills) sections.push(skills.prompt);
    agent.state.systemPrompt = sections.join("\n\n");
    agent.state.model = model;
    agent.state.tools = tools.map((t) => this.toAgentTool(t));

    let toolCalls = 0;
    let finalText = "";
    this.turns = 0;
    const unsubscribe = agent.subscribe((event) => {
      switch (event.type) {
        case "turn_start":
          this.turns += 1;
          break;
        case "message_update": {
          const m = event.message;
          if (m.role === "assistant") {
            const text = contentText(m.content).trim();
            if (text) cb.onDelta?.(text);
          }
          break;
        }
        case "message_end": {
          const m = event.message;
          if (m.role === "assistant") {
            const text = contentText(m.content).trim();
            if (text) finalText = text;
          }
          break;
        }
        case "tool_execution_start": {
          toolCalls += 1;
          const tool = this.byName.get(event.toolName);
          cb.onActivity?.(tool ? tool.statusFor((event.args ?? {}) as Record<string, unknown>) : `${event.toolName}…`);
          break;
        }
      }
    });
    const onAbort = () => agent.abort();
    cb.signal?.addEventListener("abort", onAbort);

    this.probe.reset();
    this.busy = true;
    try {
      await agent.prompt(question, images);
      // A job that ended in the last moments of the run queued its
      // wake-up after the loop's final steering poll — the one window
      // where steering alone would leave the conversation asleep on a
      // message it already holds. continue() drains exactly that.
      while (agent.hasQueuedMessages() && !cb.signal?.aborted && this.turns < MAX_TURNS) {
        await agent.continue();
      }
      const error = agent.state.errorMessage;
      if (cb.signal?.aborted) throw new Error("Cancelled.");
      if (error) throw new Error(explainAskError(error, this.probe.lastFailure));
      // Out of budget. Whatever the model had written by then is worth
      // showing — it is usually the plan it was working through — so this
      // is a note under an answer, not the loss of one.
      if (this.turns >= MAX_TURNS) {
        const note = `Stopped after ${MAX_TURNS} steps — say “continue” to let it keep going, or narrow the question.`;
        if (!finalText) throw new Error(note);
        return { text: `${finalText}\n\n*${note}*`, toolCalls };
      }
      if (!finalText) throw new Error("The model returned no answer — try again.");
      return { text: finalText, toolCalls };
    } finally {
      this.busy = false;
      unsubscribe();
      cb.signal?.removeEventListener("abort", onAbort);
      this.cb = {};
    }
  }
}

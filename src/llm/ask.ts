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
 * The model gets the kernel index (which library covers what) in its
 * system prompt, plus the inventory of command-line tools actually
 * installed on this machine — a shell it doesn't know the contents of is
 * a shell it never uses. The tool surface is assembled by the plugin:
 * library search/read always, shell and MCP tools per settings.
 */
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  contentText,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type MutableModels,
} from "@earendil-works/pi-ai";
import type { ApprovalRequest, AskTool } from "./agentTools";
import { createTransportProbe, describeError, type DiagnoseFn, type TransportProbe } from "./transport";

/** Runaway guard: one question should never burn more turns than this. */
const MAX_TURNS = 16;

const SYSTEM_PROMPT = `You answer questions using the notes in this vault: the team's shared knowledge libraries (the map below tells you which library covers which topics) and the user's own personal notes (everything outside the library folders — not mapped, just search them).

Rules:
- ALWAYS look before you answer: pick the likely library from the map (or search the whole vault when the question sounds personal), call search_notes, read the most promising notes with read_note. The notes are the source of truth; your general knowledge is only for interpreting them.
- If the notes don't answer the question, say so plainly — never invent an answer that isn't in the libraries.
- Other tools (shell commands, connected services) may be available; use them when they genuinely help answer or complete what was asked. The inventory below lists the command-line tools installed on this machine — consult it before concluding you can't reach some data or system. The user approves risky actions individually — a declined action is an answer, not an obstacle: work with what you have.
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
  /** The kernel index content (library map), or null before first sync. */
  libraryMap: () => string | null;
  /** The installed-CLI block for the system prompt, or null when there is
   *  nothing to advertise. Resolved per question, so a tool installed
   *  mid-session shows up after a refresh. */
  cliManifest?: () => Promise<string | null>;
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

export class AskEngine {
  private agent: Agent | null = null;
  private byName = new Map<string, AskTool>();
  private cb: AskCallbacks = {};
  /** Transcript restored from a saved session, applied on next ask. */
  private pendingHistory: Message[] | null = null;
  private probe: TransportProbe;

  constructor(private deps: AskDeps) {
    this.probe = createTransportProbe(
      (line, failed) => this.deps.onTransport?.(line, failed),
      undefined,
      (url) => this.deps.diagnose?.(url) ?? Promise.resolve(null),
    );
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

  /** Drop the conversation; the next ask starts fresh. */
  reset(): void {
    this.agent?.abort();
    this.agent = null;
    this.pendingHistory = null;
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

    // Both are per-question: settings, MCP config and the installed CLIs
    // can all change between asks. Resolved together so neither waits.
    const [tools, cliManifest] = await Promise.all([this.deps.tools(), this.deps.cliManifest?.() ?? null]);
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
    agent.state.systemPrompt = sections.join("\n\n");
    agent.state.model = model;
    agent.state.tools = tools.map((t) => this.toAgentTool(t));

    let toolCalls = 0;
    let turns = 0;
    let finalText = "";
    const unsubscribe = agent.subscribe((event) => {
      switch (event.type) {
        case "turn_start":
          turns += 1;
          if (turns > MAX_TURNS) agent.abort();
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
            const done = m as AssistantMessage;
            const text = contentText(done.content).trim();
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
    try {
      await agent.prompt(question, images);
      const error = agent.state.errorMessage;
      if (cb.signal?.aborted) throw new Error("Cancelled.");
      if (turns > MAX_TURNS) throw new Error("The model kept working without answering — try a more specific question.");
      if (error) throw new Error(explainAskError(error, this.probe.lastFailure));
      if (!finalText) throw new Error("The model returned no answer — try again.");
      return { text: finalText, toolCalls };
    } finally {
      unsubscribe();
      cb.signal?.removeEventListener("abort", onAbort);
      this.cb = {};
    }
  }
}

/**
 * Ask: answer a question from the team knowledge libraries, inside the
 * plugin — no external agent required.
 *
 * A deliberately thin tool loop over pi-ai's completeSimple: the model
 * gets the kernel index (which library covers what) in its system prompt
 * and two local tools — search_notes and read_note, both confined to the
 * library folders. It picks a library, searches, reads a few notes, and
 * answers with [[wiki-link]] citations. No network beyond the model call.
 */
import { Type } from "typebox";
import { contentText, type AssistantMessage, type Message, type MutableModels, type ToolCall } from "@earendil-works/pi-ai";
import type { ManifestRepo } from "../covault/manifest";
import { searchLibraries, readLibraryNote } from "../covault/librarySearch";

const MAX_TURNS = 8;

const SYSTEM_PROMPT = `You answer questions for a team using their shared knowledge libraries — folders of Markdown notes synced into this vault. The library map below tells you which library covers which topics.

Rules:
- ALWAYS look before you answer: pick the likely library from the map, call search_notes, read the most promising notes with read_note. The notes are the source of truth; your general knowledge is only for interpreting them.
- If the notes don't answer the question, say so plainly — never invent an answer that isn't in the libraries.
- Answer in the language the question was asked in.
- Keep answers focused; quote concrete facts (names, values, steps) from the notes.
- End with a "Sources:" line listing every note you used, each as an Obsidian wiki link: [[path/to/note.md]] (the vault-relative path you saw in tool results).`;

const TOOLS = [
  {
    name: "search_notes",
    description:
      "Search the knowledge libraries for notes matching a query. Returns the best-matching note paths with a few matching lines each. Optionally restrict to one library (its folder path or name from the map).",
    parameters: Type.Object({
      query: Type.String({ description: "Free-text search terms (any language)." }),
      library: Type.Optional(Type.String({ description: "Library folder path or name to search in. Omit to search all." })),
    }),
  },
  {
    name: "read_note",
    description: "Read one note's full content by its vault-relative path (as returned by search_notes).",
    parameters: Type.Object({
      path: Type.String({ description: "Vault-relative note path, e.g. teams/ccp-kb/02_domain/refunds.md" }),
    }),
  },
];

export interface AskProgress {
  /** Human-readable line for the UI status area. */
  text: string;
}

export interface AskAnswer {
  text: string;
  turns: number;
  toolCalls: number;
  costUsd: number;
}

export interface AskDeps {
  models: MutableModels;
  getSelection: () => { provider: string; model: string };
  hasKey: (provider: string) => boolean;
  vaultBase: () => string;
  repos: () => ManifestRepo[];
  /** The kernel index content (library map), or null before first sync. */
  libraryMap: () => string | null;
}

export class AskEngine {
  /** Conversation so far — kept so follow-up questions have context. */
  private messages: Message[] = [];

  constructor(private deps: AskDeps) {}

  isEnabled(): boolean {
    const { provider, model } = this.deps.getSelection();
    return !!provider && !!model && this.deps.hasKey(provider);
  }

  reset(): void {
    this.messages = [];
  }

  private executeTool(call: ToolCall): { text: string; isError: boolean; status: string } {
    const repos = this.deps.repos();
    const base = this.deps.vaultBase();
    if (call.name === "search_notes") {
      const query = String(call.arguments.query ?? "");
      const library = call.arguments.library ? String(call.arguments.library) : undefined;
      const hits = searchLibraries(base, repos, query, library);
      const status = library ? `Searching ${library}…` : "Searching the libraries…";
      if (hits.length === 0) return { text: "No matching notes.", isError: false, status };
      const text = hits
        .map((h) => `${h.path}\n${h.lines.map((l) => `  > ${l}`).join("\n")}`)
        .join("\n\n");
      return { text, isError: false, status };
    }
    if (call.name === "read_note") {
      const notePath = String(call.arguments.path ?? "");
      const content = readLibraryNote(base, repos, notePath);
      const status = `Reading ${notePath.split("/").pop() ?? notePath}…`;
      if (content === null) {
        return { text: `Note not found or outside the libraries: ${notePath}`, isError: true, status };
      }
      return { text: content, isError: false, status };
    }
    return { text: `Unknown tool: ${call.name}`, isError: true, status: "…" };
  }

  /** Ask a question; resolves with the final answer. */
  async ask(
    question: string,
    opts: { signal?: AbortSignal; onProgress?: (p: AskProgress) => void } = {},
  ): Promise<AskAnswer> {
    const { provider, model: modelId } = this.deps.getSelection();
    const model = this.deps.models.getModel(provider, modelId);
    if (!model) throw new Error(`Model ${provider}/${modelId} is not available — pick one in Settings.`);

    const map = this.deps.libraryMap();
    const systemPrompt = map ? `${SYSTEM_PROMPT}\n\n=== Library map ===\n${map}` : SYSTEM_PROMPT;

    this.messages.push({ role: "user", content: question, timestamp: Date.now() });

    let toolCalls = 0;
    let costUsd = 0;
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      if (opts.signal?.aborted) throw new Error("Cancelled.");
      opts.onProgress?.({ text: turn === 1 ? "Thinking…" : "Writing the answer…" });

      const reply: AssistantMessage = await this.deps.models.completeSimple(model, {
        systemPrompt,
        messages: this.messages,
        tools: TOOLS,
      });
      this.messages.push(reply);
      costUsd += reply.usage?.cost?.total ?? 0;

      const calls = reply.content.filter((c): c is ToolCall => c.type === "toolCall");
      if (calls.length === 0) {
        return { text: contentText(reply.content).trim(), turns: turn, toolCalls, costUsd };
      }

      for (const call of calls) {
        if (opts.signal?.aborted) throw new Error("Cancelled.");
        toolCalls += 1;
        const { text, isError, status } = this.executeTool(call);
        opts.onProgress?.({ text: status });
        this.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text }],
          isError,
          timestamp: Date.now(),
        });
      }
    }
    throw new Error("The model kept searching without answering — try a more specific question.");
  }
}

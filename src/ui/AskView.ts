/**
 * Ask view: a chat with the team's knowledge libraries, right in the
 * sidebar. The AskEngine (plugin-side) does the model + tool loop; this
 * view renders the conversation, streams status lines while the agent
 * searches, and makes every [[citation]] a real, clickable vault link.
 */
import { ItemView, MarkdownRenderer, setIcon, type WorkspaceLeaf } from "obsidian";
import type CovaultPlugin from "../main";
import type { AskEngine } from "../llm/ask";

export const COVAULT_ASK_VIEW_TYPE = "covault-ask";

interface Turn {
  question: string;
  answer?: string;
  error?: string;
}

export class AskView extends ItemView {
  private engine: AskEngine;
  private turns: Turn[] = [];
  private running: AbortController | null = null;

  private listEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: CovaultPlugin,
  ) {
    super(leaf);
    this.engine = plugin.newAskEngine();
  }

  getViewType(): string {
    return COVAULT_ASK_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Ask Covault";
  }
  getIcon(): string {
    return "message-circle-question";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("covault-ask");

    const head = root.createDiv("covault-ask-head");
    head.createSpan({ cls: "covault-ask-title", text: "Ask your knowledge base" });
    const clear = head.createEl("button", { cls: "covault-panel-icon-btn", attr: { "aria-label": "New conversation" } });
    setIcon(clear, "rotate-ccw");
    clear.onclick = () => {
      this.running?.abort();
      this.engine.reset();
      this.turns = [];
      this.renderTurns();
    };

    this.listEl = root.createDiv("covault-ask-list");
    // Citations render as normal wiki links; make them open the note.
    this.listEl.addEventListener("click", (evt) => {
      const link = (evt.target as HTMLElement).closest("a.internal-link");
      if (!link) return;
      evt.preventDefault();
      const href = link.getAttribute("data-href") ?? link.getAttribute("href");
      if (href) void this.app.workspace.openLinkText(href, "", false);
    });

    this.statusEl = root.createDiv("covault-ask-status");

    const inputRow = root.createDiv("covault-ask-input");
    this.inputEl = inputRow.createEl("textarea", {
      attr: { rows: "2", placeholder: "Ask about anything in your team's libraries…" },
    });
    this.inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing) {
        evt.preventDefault();
        void this.submit();
      }
    });
    this.sendBtn = inputRow.createEl("button", { cls: "mod-cta", text: "Ask" });
    this.sendBtn.onclick = () => void this.submit();

    this.renderTurns();
  }

  async onClose(): Promise<void> {
    this.running?.abort();
  }

  private async submit(): Promise<void> {
    if (this.running) {
      // The button doubles as Stop while a question is in flight.
      this.running.abort();
      return;
    }
    const question = this.inputEl.value.trim();
    if (!question) return;

    if (!this.engine.isEnabled()) {
      this.statusEl.setText("Set up an AI provider and key first (Settings → Covault → AI engine).");
      return;
    }
    if (this.plugin.libraryManifest.load().repos.length === 0) {
      this.statusEl.setText("No knowledge libraries yet — add one via the Covault panel first.");
      return;
    }

    const turn: Turn = { question };
    this.turns.push(turn);
    this.inputEl.value = "";
    this.renderTurns();

    this.running = new AbortController();
    this.sendBtn.setText("Stop");
    try {
      const answer = await this.engine.ask(question, {
        signal: this.running.signal,
        onProgress: (p) => this.statusEl.setText(p.text),
      });
      turn.answer = answer.text;
    } catch (e) {
      turn.error = (e as Error).message;
    } finally {
      this.running = null;
      this.sendBtn.setText("Ask");
      this.statusEl.setText("");
      this.renderTurns();
    }
  }

  private renderTurns(): void {
    this.listEl.empty();
    if (this.turns.length === 0) {
      this.listEl.createDiv({
        cls: "covault-ask-empty",
        text: "Answers come from your team's knowledge libraries, with links to the notes they're based on.",
      });
      return;
    }
    for (const turn of this.turns) {
      this.listEl.createDiv({ cls: "covault-ask-q", text: turn.question });
      if (turn.answer !== undefined) {
        const a = this.listEl.createDiv("covault-ask-a");
        void MarkdownRenderer.render(this.app, turn.answer, a, "", this);
      } else if (turn.error !== undefined) {
        this.listEl.createDiv({ cls: "covault-ask-err", text: turn.error });
      } else {
        this.listEl.createDiv({ cls: "covault-ask-a covault-ask-pending", text: "…" });
      }
    }
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }
}

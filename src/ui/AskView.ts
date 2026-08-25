/**
 * Ask view: a chat with the team's knowledge libraries, right in the
 * sidebar. The AskEngine (plugin-side) does the model + tool loop; this
 * view renders the conversation, streams status lines while the agent
 * searches, and makes every [[citation]] a real, clickable vault link.
 */
import { ItemView, MarkdownRenderer, setIcon, type WorkspaceLeaf } from "obsidian";
import type CovaultPlugin from "../main";
import type { AskEngine } from "../llm/ask";
import { ConfirmModal } from "./ConfirmModal";
import { DiffApproveModal } from "./DiffApproveModal";
import type { ApprovalRequest } from "../llm/agentTools";

export const COVAULT_ASK_VIEW_TYPE = "covault-ask";

interface Turn {
  question: string;
  answer?: string;
  /** Streaming text while the answer is being written. */
  partial?: string;
  activity: string[];
  error?: string;
}

export class AskView extends ItemView {
  private engine: AskEngine;
  private turns: Turn[] = [];
  private running: AbortController | null = null;
  /** Actions the user already allowed in this conversation — don't re-ask. */
  private approved = new Set<string>();

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
      this.approved.clear();
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

    const turn: Turn = { question, activity: [] };
    this.turns.push(turn);
    this.inputEl.value = "";
    this.renderTurns();

    this.running = new AbortController();
    this.sendBtn.setText("Stop");
    this.statusEl.setText("Thinking…");
    try {
      const answer = await this.engine.ask(question, {
        signal: this.running.signal,
        onDelta: (text) => {
          turn.partial = text;
          this.statusEl.setText("Writing…");
          this.renderTurns();
        },
        onActivity: (line) => {
          turn.activity.push(line);
          this.statusEl.setText(line);
          this.renderTurns();
        },
        approve: (action) => this.approveAction(action),
      });
      turn.answer = answer.text;
    } catch (e) {
      turn.error = (e as Error).message;
    } finally {
      turn.partial = undefined;
      this.running = null;
      this.sendBtn.setText("Ask");
      this.statusEl.setText("");
      this.renderTurns();
    }
  }

  /** Approval gate. Plain actions are remembered per conversation once
   *  allowed; anything carrying a diff (a note edit) is shown and
   *  confirmed every single time. */
  private async approveAction(request: ApprovalRequest): Promise<boolean> {
    if (request.diff) return DiffApproveModal.ask(this.app, request.action, request.diff);
    if (this.approved.has(request.action)) return true;
    const ok = await ConfirmModal.ask(this.app, {
      title: "Allow this action?",
      message: request.action,
      cta: "Allow",
    });
    if (ok) this.approved.add(request.action);
    return ok;
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
      for (const line of turn.activity) {
        this.listEl.createDiv({ cls: "covault-ask-activity", text: line });
      }
      if (turn.answer !== undefined) {
        const a = this.listEl.createDiv("covault-ask-a");
        void MarkdownRenderer.render(this.app, turn.answer, a, "", this);
      } else if (turn.error !== undefined) {
        this.listEl.createDiv({ cls: "covault-ask-err", text: turn.error });
      } else if (turn.partial) {
        // Streaming: plain text while it grows, real Markdown once done.
        this.listEl.createDiv({ cls: "covault-ask-a covault-ask-pending", text: turn.partial });
      } else {
        this.listEl.createDiv({ cls: "covault-ask-a covault-ask-pending", text: "…" });
      }
    }
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }
}

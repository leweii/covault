/**
 * Ask view: a chat with the vault's knowledge, right in the sidebar.
 * The AskEngine (plugin-side) does the model + tool loop; this view
 * renders conversations, streams status while the agent works, and makes
 * every [[citation]] a real, clickable vault link.
 *
 * Conversations persist device-locally (ChatStore) with their raw agent
 * transcripts, so reopening a session resumes the model's context, not
 * just the text on screen.
 */
import { ItemView, MarkdownRenderer, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import * as path from "path";
import type CovaultPlugin from "../main";
import { withoutImageData, type AskEngine } from "../llm/ask";
import type { Message } from "@earendil-works/pi-ai";
import { ChatStore, newSessionId, titleFor, type ChatSession, type ChatTurn } from "../covault/chatStore";
import { ConfirmModal } from "./ConfirmModal";
import { DiffApproveModal } from "./DiffApproveModal";
import type { ApprovalRequest } from "../llm/agentTools";
import {
  dataUrl,
  describeBytes,
  imageFilesFrom,
  toImageContent,
  MAX_IMAGES,
  type PastedImage,
} from "../llm/images";

export const COVAULT_ASK_VIEW_TYPE = "covault-ask";

/** Never draggable below roughly two lines — a composer you cannot see
 *  what you typed in is not a composer. */
const MIN_COMPOSER_PX = 46;

/** How the newline chord is written in the hint. */
const MOD_KEY = process.platform === "darwin" ? "\u2318" : "Ctrl+";

export class AskView extends ItemView {
  private engine: AskEngine;
  private store: ChatStore;
  private session: ChatSession;
  private running: AbortController | null = null;
  private showSessions = false;
  /** Actions the user already allowed in this conversation — don't re-ask. */
  private approved = new Set<string>();

  /** Images pasted for the question being composed, not yet sent. */
  private attached: PastedImage[] = [];

  private mcpEl!: HTMLElement;
  private listEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private attachEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private hintEl!: HTMLElement;
  /** Height the user dragged the composer to, in px. Null = follow the
   *  text (autoGrow). Restored from settings on open. */
  private manualHeight: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: CovaultPlugin,
  ) {
    super(leaf);
    this.engine = plugin.newAskEngine();
    this.store = new ChatStore(
      path.join(plugin.vaultBasePath(), this.app.vault.configDir, "plugins", "covault", "chats.json"),
    );
    this.session = this.freshSession();
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

  private freshSession(): ChatSession {
    return { id: newSessionId(), title: "New chat", updatedAt: Date.now(), turns: [], transcript: [] };
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("covault-ask");

    const head = root.createDiv("covault-ask-head");
    const historyBtn = head.createEl("button", { cls: "covault-panel-icon-btn", attr: { "aria-label": "Chat history" } });
    setIcon(historyBtn, "history");
    historyBtn.onclick = () => {
      this.showSessions = !this.showSessions;
      this.renderTurns();
    };
    head.createSpan({ cls: "covault-ask-title", text: "Ask your knowledge base" });
    const newBtn = head.createEl("button", { cls: "covault-panel-icon-btn", attr: { "aria-label": "New chat" } });
    setIcon(newBtn, "plus");
    newBtn.onclick = () => this.startNewChat();

    this.listEl = root.createDiv("covault-ask-list");
    this.listEl.addEventListener("click", (evt) => {
      const link = (evt.target as HTMLElement).closest("a.internal-link");
      if (!link) return;
      // A drag that happens to end on a citation is someone copying text,
      // not asking to navigate away from it.
      if (!window.getSelection()?.isCollapsed) return;
      evt.preventDefault();
      const href = link.getAttribute("data-href") ?? link.getAttribute("href");
      if (href) void this.app.workspace.openLinkText(href, "", false);
    });

    // Connected-service state lives here, not in the conversation: asking
    // a question never triggers a sign-in, so this is the only place it
    // can be noticed and acted on.
    this.mcpEl = root.createDiv("covault-ask-mcp");
    this.renderMcpChips();
    // Probe silently on open so a service needing sign-in is visible
    // before the first question rather than after it.
    void this.plugin.mcp.tools().then(() => this.renderMcpChips());

    this.statusEl = root.createDiv("covault-ask-status");

    // Above the composer: thumbnails of what will ride along with the
    // question, each removable before sending.
    this.attachEl = root.createDiv("covault-ask-attach");

    const inputRow = root.createDiv("covault-ask-input");
    this.buildGrip(inputRow);
    this.inputEl = inputRow.createEl("textarea", {
      attr: { placeholder: "Ask about anything in your vault…" },
    });
    this.inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !evt.isComposing) {
        evt.preventDefault();
        // A bare ↩ sends, because that is what the question is for.
        // ⌘↩ (⌃↩ off the Mac) and ⇧↩ break the line instead.
        if (evt.metaKey || evt.ctrlKey || evt.shiftKey) this.insertNewline();
        else void this.submit();
        return;
      }
      if (evt.key === "Escape" && this.running) {
        evt.preventDefault();
        this.running.abort();
      }
    });
    // The composer follows the question. Two fixed lines meant a long
    // one had to be read through a slit.
    this.inputEl.addEventListener("input", () => this.autoGrow());
    this.inputEl.addEventListener("paste", (evt) => {
      const files = imageFilesFrom(evt.clipboardData);
      if (files.length === 0) return; // plain text paste — leave it alone
      evt.preventDefault();
      void this.attach(files);
    });
    // Dropping a screenshot onto the composer reads as the same gesture.
    this.inputEl.addEventListener("dragover", (evt) => {
      if (imageFilesFrom(evt.dataTransfer).length > 0 || evt.dataTransfer?.types.includes("Files")) {
        evt.preventDefault();
      }
    });
    this.inputEl.addEventListener("drop", (evt) => {
      const files = imageFilesFrom(evt.dataTransfer);
      if (files.length === 0) return;
      evt.preventDefault();
      void this.attach(files);
    });
    this.hintEl = inputRow.createDiv("covault-ask-hint");

    const saved = this.plugin.settings.ask.composerHeight;
    if (saved > 0) this.applyHeight(saved);
    this.autoGrow();
    this.renderHint();
    this.renderAttachments();
    this.renderTurns();
  }

  async onClose(): Promise<void> {
    this.running?.abort();
  }

  /**
   * Take pasted/dropped image files into the composer. Each is normalized
   * (scaled down, re-encoded) before it counts against the cap, and a
   * failure names the file rather than killing the whole paste.
   */
  private async attach(files: File[]): Promise<void> {
    if (!this.engine.isEnabled()) {
      this.statusEl.setText("Set up an AI provider and key first (Settings → Covault → AI engine).");
      return;
    }
    if (!this.engine.supportsImages()) {
      this.statusEl.setText("The selected model can't read images — pick one with vision in Settings → Covault → AI.");
      return;
    }
    const room = MAX_IMAGES - this.attached.length;
    if (room <= 0) {
      this.statusEl.setText(`Up to ${MAX_IMAGES} images per question.`);
      return;
    }
    if (files.length > room) {
      new Notice(`Covault: only the first ${room} image${room === 1 ? "" : "s"} were attached (max ${MAX_IMAGES}).`);
    }
    this.statusEl.setText("Preparing image…");
    for (const file of files.slice(0, room)) {
      try {
        this.attached.push(await toImageContent(file));
      } catch (e) {
        new Notice(`Covault: ${(e as Error).message}`);
      }
    }
    this.statusEl.setText("");
    this.renderAttachments();
    this.inputEl.focus();
  }

  /**
   * One chip per connected service that needs attention. Clicking a
   * "Sign in" chip is the only thing in this view that opens a browser —
   * questions connect silently and simply go without those tools.
   */
  private renderMcpChips(): void {
    this.mcpEl.empty();
    const needsAuth = this.plugin.mcp.needingSignIn();
    const broken = this.plugin.mcp.broken();
    this.mcpEl.toggleClass("is-empty", needsAuth.length === 0 && broken.length === 0);

    for (const server of needsAuth) {
      const chip = this.mcpEl.createEl("button", { cls: "covault-ask-mcp-chip mod-warning" });
      setIcon(chip.createSpan("covault-ask-mcp-icon"), "log-in");
      chip.createSpan({ text: `Sign in to ${server.name}` });
      chip.onclick = () => void this.signIn(server.name, chip);
    }
    for (const server of broken) {
      const chip = this.mcpEl.createDiv("covault-ask-mcp-chip is-broken");
      setIcon(chip.createSpan("covault-ask-mcp-icon"), "alert-triangle");
      chip.createSpan({ text: `${server.name} — ${server.error ?? "unavailable"}` });
    }
  }

  private async signIn(name: string, chip: HTMLElement): Promise<void> {
    chip.setAttribute("disabled", "true");
    chip.setText(`Signing in to ${name}…`);
    try {
      await this.plugin.mcp.signIn(name);
      new Notice(`Covault: connected to "${name}".`);
    } catch (e) {
      new Notice(`Covault: couldn't connect to "${name}" — ${(e as Error).message}`, 10_000);
    } finally {
      this.renderMcpChips();
    }
  }

  private renderAttachments(): void {
    this.attachEl.empty();
    this.attachEl.toggleClass("is-empty", this.attached.length === 0);
    this.attached.forEach((image, i) => {
      const chip = this.attachEl.createDiv("covault-ask-chip");
      chip.createEl("img", { attr: { src: dataUrl(image), alt: image.name } });
      chip.createSpan({ cls: "covault-ask-chip-meta", text: describeBytes(image.bytes) });
      const remove = chip.createEl("button", {
        cls: "covault-ask-chip-x",
        attr: { "aria-label": `Remove ${image.name}` },
      });
      setIcon(remove, "x");
      remove.onclick = () => {
        this.attached.splice(i, 1);
        this.renderAttachments();
      };
    });
  }

  private startNewChat(): void {
    this.running?.abort();
    this.engine.reset();
    this.approved.clear();
    this.attached = [];
    this.session = this.freshSession();
    this.showSessions = false;
    this.renderAttachments();
    this.renderTurns();
  }

  private openSession(saved: ChatSession): void {
    this.running?.abort();
    this.approved.clear();
    this.attached = [];
    this.session = saved;
    this.engine.setTranscript(saved.transcript as Message[]);
    this.showSessions = false;
    this.renderAttachments();
    this.renderTurns();
  }

  /** Persist after every completed turn — a crash costs one answer, not
   *  the conversation. */
  private persist(): void {
    if (this.session.turns.length === 0) return;
    this.session.updatedAt = Date.now();
    this.session.transcript = withoutImageData(this.engine.getTranscript());
    try {
      this.store.save(this.session);
    } catch (e) {
      console.warn("[covault] couldn't save the chat session:", e);
    }
  }

  /**
   * The drag handle above the composer.
   *
   * The top edge is the one that moves: the box is pinned to the bottom
   * of the panel, so a native bottom-right resize corner would sit still
   * while the pointer moved away from it. Dragging up makes it taller and
   * the transcript shorter, which is the trade the user is making.
   */
  private buildGrip(row: HTMLElement): void {
    const grip = row.createDiv("covault-ask-grip");
    grip.setAttribute("aria-label", "Drag to resize — double-click to fit the text");
    grip.addEventListener("pointerdown", (evt) => {
      // Or the drag selects the transcript instead of resizing.
      evt.preventDefault();
      const startY = evt.clientY;
      const startHeight = this.inputEl.getBoundingClientRect().height;
      grip.setPointerCapture(evt.pointerId);
      const onMove = (move: PointerEvent) => this.applyHeight(startHeight + (startY - move.clientY));
      const onUp = () => {
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
        // Saved on release, not per pixel.
        this.plugin.settings.ask.composerHeight = this.manualHeight ?? 0;
        void this.plugin.saveSettings();
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
    });
    // A way back to automatic that doesn't need a settings trip.
    grip.addEventListener("dblclick", () => {
      this.manualHeight = null;
      this.inputEl.style.maxHeight = "";
      this.plugin.settings.ask.composerHeight = 0;
      void this.plugin.saveSettings();
      this.autoGrow();
    });
  }

  /** Set a dragged height, clamped so the composer can neither disappear
   *  nor swallow the conversation it is part of. */
  private applyHeight(px: number): void {
    const panel = this.contentEl.clientHeight || 0;
    const max = panel > 0 ? Math.max(MIN_COMPOSER_PX, panel * 0.75) : px;
    const height = Math.round(Math.min(Math.max(px, MIN_COMPOSER_PX), max));
    this.manualHeight = height;
    // The CSS cap exists to stop autoGrow from eating the panel; a height
    // the user dragged to is not autoGrow's business.
    this.inputEl.style.maxHeight = "none";
    this.inputEl.style.height = `${height}px`;
  }

  /**
   * Height follows content, up to the max-height in CSS — past that the
   * textarea scrolls. Borders are added back because the element is
   * border-box while scrollHeight is not.
   */
  private autoGrow(): void {
    // A height the user chose by hand outranks the text.
    if (this.manualHeight !== null) return;
    const el = this.inputEl;
    el.style.height = "auto";
    // Called once at build time too, when the leaf may not be laid out
    // yet — measuring then would pin the box to zero.
    if (el.scrollHeight === 0) return;
    const style = getComputedStyle(el);
    const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.style.height = `${el.scrollHeight + (Number.isFinite(borders) ? borders : 0)}px`;
  }

  /** ⌘↩ / ⇧↩: a line break at the caret. Done by hand because the
   *  keydown that carries it is the one we cancel to keep ↩ sending. */
  private insertNewline(): void {
    const el = this.inputEl;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.value = `${el.value.slice(0, start)}\n${el.value.slice(end)}`;
    el.selectionStart = el.selectionEnd = start + 1;
    this.autoGrow();
    // Typing at the end of a box already at its max height would put the
    // new line out of sight.
    if (el.selectionStart === el.value.length) el.scrollTop = el.scrollHeight;
  }

  /** What the two keys do, said quietly under the box — and while the
   *  agent is working, the one key that stops it. */
  private renderHint(): void {
    this.hintEl.empty();
    const key = (keys: string, label: string) => {
      const pair = this.hintEl.createSpan("covault-ask-hint-pair");
      pair.createEl("kbd", { text: keys });
      pair.appendText(label);
    };
    if (this.running) {
      key("Esc", "stop");
      return;
    }
    key("\u21a9", "send");
    key(`${MOD_KEY}\u21a9`, "new line");
  }

  private async submit(): Promise<void> {
    if (this.running) {
      this.running.abort();
      return;
    }
    const question = this.inputEl.value.trim();
    const images = this.attached;
    // An image on its own is a question ("what is this?"); text is only
    // required when there is nothing else to go on.
    if (!question && images.length === 0) return;

    if (!this.engine.isEnabled()) {
      this.statusEl.setText("Set up an AI provider and key first (Settings → Covault → AI engine).");
      return;
    }

    const turn: ChatTurn = { question, activity: [] };
    if (images.length > 0) {
      // Write the bytes out now: the turn survives in chats.json, which
      // only ever holds the file names.
      turn.images = images.map((image, i) => this.store.attachments.save(this.session.id, image, i));
    }
    this.session.turns.push(turn);
    if (this.session.turns.length === 1) {
      this.session.title = titleFor(question || `${images.length} image${images.length === 1 ? "" : "s"}`);
    }
    this.inputEl.value = "";
    this.autoGrow();
    this.attached = [];
    this.showSessions = false;
    this.renderAttachments();
    this.renderTurns();

    this.running = new AbortController();
    this.renderHint();
    this.statusEl.setText("Thinking… (Esc to stop)");
    let partial = "";
    try {
      const answer = await this.engine.ask(
        question || "What do you make of this?",
        {
          signal: this.running.signal,
          onDelta: (text) => {
            partial = text;
            this.statusEl.setText("Writing… (Esc to stop)");
            this.renderTurns(partial);
          },
          onActivity: (line) => {
            turn.activity.push(line);
            this.statusEl.setText(line);
            this.renderTurns(partial);
          },
          approve: (request) => this.approveAction(request),
        },
        images,
      );
      turn.answer = answer.text;
      turn.costUsd = answer.costUsd;
    } catch (e) {
      turn.error = (e as Error).message;
    } finally {
      this.running = null;
      this.renderHint();
      this.statusEl.setText("");
      this.persist();
      this.renderTurns();
      this.renderMcpChips();
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

  // ── Rendering ──────────────────────────────────────────────

  private renderTurns(partial?: string): void {
    this.listEl.empty();
    if (this.showSessions) {
      this.renderSessions();
      return;
    }
    const turns = this.session.turns;
    if (turns.length === 0) {
      this.listEl.createDiv({
        cls: "covault-ask-empty",
        text: "Answers come from your team's knowledge libraries and your own notes, with links to the sources.",
      });
      return;
    }
    const last = turns.length - 1;
    turns.forEach((turn, i) => {
      if (turn.images?.length) this.renderTurnImages(turn);
      if (turn.question) this.listEl.createDiv({ cls: "covault-ask-q", text: turn.question });

      const isLive = i === last && this.running !== null;
      if (turn.activity.length > 0) this.renderActivity(turn, isLive);

      if (turn.answer !== undefined) {
        this.renderAnswer(turn);
      } else if (turn.error !== undefined) {
        this.listEl.createDiv({ cls: "covault-ask-err", text: turn.error });
      } else if (isLive && partial) {
        this.listEl.createDiv({ cls: "covault-ask-a covault-ask-pending", text: partial });
      } else if (isLive) {
        this.listEl.createDiv({ cls: "covault-ask-a covault-ask-pending", text: "…" });
      }
    });
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  /** Sent images, read back from the attachment store. */
  private renderTurnImages(turn: ChatTurn): void {
    const row = this.listEl.createDiv("covault-ask-q-images");
    for (const ref of turn.images ?? []) {
      const data = this.store.attachments.read(this.session.id, ref);
      if (!data) {
        // Aged out with its session, or deleted underneath us.
        row.createSpan({ cls: "covault-ask-chip-meta", text: `[${ref.name} — no longer stored]` });
        continue;
      }
      row.createEl("img", { attr: { src: dataUrl({ data, mimeType: ref.mimeType }), alt: ref.name, title: ref.name } });
    }
  }

  /** Live: every step as it happens. Done: collapsed to "n steps". */
  private renderActivity(turn: ChatTurn, isLive: boolean): void {
    if (isLive) {
      for (const line of turn.activity) this.listEl.createDiv({ cls: "covault-ask-activity", text: line });
      return;
    }
    const details = this.listEl.createEl("details", { cls: "covault-ask-steps" });
    details.createEl("summary", { text: `${turn.activity.length} step${turn.activity.length === 1 ? "" : "s"}` });
    for (const line of turn.activity) details.createDiv({ cls: "covault-ask-activity", text: line });
  }

  private renderAnswer(turn: ChatTurn): void {
    const wrap = this.listEl.createDiv("covault-ask-a");
    const body = wrap.createDiv();
    void MarkdownRenderer.render(this.app, turn.answer ?? "", body, "", this);

    const foot = wrap.createDiv("covault-ask-foot");
    if (turn.costUsd !== undefined && turn.costUsd > 0) {
      foot.createSpan({ text: `$${turn.costUsd.toFixed(4)}` });
    }
    const copy = foot.createEl("button", { cls: "covault-panel-icon-btn", attr: { "aria-label": "Copy answer" } });
    setIcon(copy, "copy");
    copy.onclick = () => {
      void navigator.clipboard.writeText(turn.answer ?? "");
      new Notice("Copied.");
    };
  }

  private renderSessions(): void {
    const sessions = this.store.list();
    this.listEl.createDiv({ cls: "covault-ask-empty", text: sessions.length === 0 ? "No saved chats yet." : "Chat history" });
    for (const s of sessions) {
      const row = this.listEl.createDiv("covault-ask-session");
      const label = row.createDiv("covault-ask-session-label");
      label.createDiv({ cls: "covault-ask-session-title", text: s.title });
      label.createDiv({
        cls: "covault-ask-session-date",
        text: `${new Date(s.updatedAt).toLocaleString()} · ${s.turns.length} turn${s.turns.length === 1 ? "" : "s"}`,
      });
      label.onclick = () => this.openSession(s);
      const del = row.createEl("button", { cls: "covault-panel-icon-btn", attr: { "aria-label": "Delete chat" } });
      setIcon(del, "trash-2");
      del.onclick = (evt) => {
        evt.stopPropagation();
        this.store.delete(s.id);
        if (s.id === this.session.id) this.startNewChat();
        else this.renderTurns();
      };
    }
  }
}

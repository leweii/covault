/**
 * Ask view: a chat with the vault's knowledge, in a tab or a window of
 * its own.
 * The AskEngine (plugin-side) does the model + tool loop; this view
 * renders conversations, streams status while the agent works, and makes
 * every [[citation]] a real, clickable vault link.
 *
 * Conversations persist device-locally (ChatStore) with their raw agent
 * transcripts, so reopening a session resumes the model's context, not
 * just the text on screen.
 */
import { ItemView, MarkdownRenderer, Menu, Notice, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
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

/** A question typed while an answer was still streaming — or a
 *  background command reporting in, which enters the conversation the
 *  same way a question does. */
interface QueuedAsk {
  question: string;
  images: PastedImage[];
  /** "wake" = nobody typed this; a background job finished. */
  kind?: ChatTurn["kind"];
}

/** Within this much of the bottom counts as being at the bottom. */
const TAIL_SLACK_PX = 40;

/** Never draggable below roughly two lines — a composer you cannot see
 *  what you typed in is not a composer. */
const MIN_COMPOSER_PX = 46;

/** How the newline chord is written in the hint. */
const MOD_KEY = process.platform === "darwin" ? "\u2318" : "Ctrl+";

/** The headline of a multi-line machine message. */
const firstLine = (text: string): string => text.split("\n", 1)[0] ?? "";

/** The step list's summary, written in one place because the live turn
 *  rewrites it without going through a repaint. */
const stepCount = (n: number): string => `${n} step${n === 1 ? "" : "s"}`;

export class AskView extends ItemView {
  private engine: AskEngine;
  private store: ChatStore;
  /** Readable by sibling views: opening a conversation checks whether
   *  another one already has it. */
  session: ChatSession;
  private running: AbortController | null = null;
  private showSessions = false;
  /** Actions the user already allowed in this conversation — don't re-ask. */
  private approved = new Set<string>();

  /** Images pasted for the question being composed, not yet sent. */
  private attached: PastedImage[] = [];

  /** Questions asked while an answer was still being written. Sent one at
   *  a time, in order, as each turn finishes — the running turn is never
   *  disturbed by them. */
  private queue: QueuedAsk[] = [];
  /** Esc stops the turn without throwing away what was queued behind it:
   *  the queue holds until the reader sends the next one deliberately. */
  private queuePaused = false;
  /** Set once the leaf is going away, so a turn aborted by the close does
   *  not announce itself to a view that no longer exists. */
  private closing = false;

  /** Follow the answer as it streams. Off the moment the reader scrolls
   *  up — a view that keeps yanking itself to the bottom can't be read —
   *  and on again when they reach the bottom, press the button, or ask
   *  something new. */
  private followTail = true;
  /** Scroll events a rebuild causes are not the reader's doing. */
  private rebuilding = false;
  /** Which turns' step lists the reader opened, so a rebuild does not
   *  slam them shut. */
  private stepsOpen = new Set<number>();
  /** The answer as far as it has streamed. Held here rather than passed
   *  around, so any repaint — including one deferred past a selection —
   *  can put the live text back where it was. */
  private livePartial = "";
  /** The two nodes a streaming turn writes into. Held so a chunk can be
   *  appended to them instead of rebuilding the transcript around them:
   *  a rebuild deletes the nodes a selection is anchored in, which is
   *  what made text impossible to select while an answer was arriving. */
  private liveEl: HTMLElement | null = null;
  private liveSteps: HTMLElement | null = null;
  /** A repaint that arrived while the reader was holding a selection,
   *  waiting for them to let go of it. */
  private repaintPending = false;

  private mcpEl!: HTMLElement;
  private tailBtn!: HTMLElement;
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
    // The other half of run_in_background: a job that ends while no turn
    // is running has nowhere to report, so it opens one.
    this.engine.onWake = (note) => this.onBackgroundWake(note);
    this.store = new ChatStore(
      path.join(plugin.vaultBasePath(), this.app.vault.configDir, "plugins", "covault", "chats.json"),
    );
    this.session = this.freshSession();
  }

  getViewType(): string {
    return COVAULT_ASK_VIEW_TYPE;
  }
  /** With several conversations open, the tab titles are the only way to
   *  tell them apart — and the dot is how a background one says it is
   *  still working. */
  getDisplayText(): string {
    const named = this.session.turns.length > 0 ? this.session.title : "Ask Covault";
    if (this.running) return `\u25cf ${named}`;
    // Hollow: nothing is being written, but a command is still running
    // and this tab will come back to life on its own.
    return this.engine.runningJobs().length > 0 ? `\u25cb ${named}` : named;
  }

  /** Nothing re-reads getDisplayText() on its own. updateHeader is not in
   *  the public typings but is what the tab header calls; optional so a
   *  future rename degrades to a stale title, not a crash. */
  private refreshHeader(): void {
    (this.leaf as Partial<{ updateHeader(): void }>).updateHeader?.();
  }

  /** Where the window variant lives, since the header's plus is the tab
   *  one. Also the only route for a popped-out Ask, which has no tab strip
   *  of its own to right-click. */
  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    menu.addItem((item) =>
      item
        .setTitle("New chat in a new window")
        .setIcon("plus")
        .onClick(() => void this.plugin.openAskWindow()),
    );
    menu.addItem((item) =>
      item
        .setTitle("Move this chat to its own window")
        .setIcon("picture-in-picture-2")
        .onClick(() => {
          this.app.workspace.moveLeafToPopout(this.leaf);
        }),
    );
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
    const headActions = head.createDiv("covault-ask-head-actions");
    // One action, and it never touches this conversation: a new chat is a
    // new tab beside this one, so what you are reading — or are still
    // waiting on — stays exactly where it is. Same window, because a chat
    // started from here belongs with the chats it was started from.
    const newBtn = headActions.createEl("button", {
      cls: "covault-panel-icon-btn",
      attr: { "aria-label": "New chat in a new tab" },
    });
    setIcon(newBtn, "plus");
    newBtn.onclick = () => void this.plugin.openAskTab(this.leaf);

    // A wrapper, because a button positioned inside a scrolling box
    // scrolls away with the content it is meant to escape.
    const listWrap = root.createDiv("covault-ask-list-wrap");
    this.listEl = listWrap.createDiv("covault-ask-list");
    this.listEl.addEventListener("scroll", () => this.onListScroll());
    // Letting go of a selection is what releases the repaints held back
    // while it existed. Bound on the whole view, because a selection is
    // just as often ended by clicking somewhere else in it.
    this.registerDomEvent(this.containerEl, "pointerup", () => this.flushRepaint());
    this.registerDomEvent(this.containerEl, "keyup", () => this.flushRepaint());
    this.listEl.addEventListener("click", (evt) => {
      const link = (evt.target as HTMLElement).closest("a.internal-link");
      if (!link) return;
      // A drag that happens to end on a citation is someone copying text,
      // not asking to navigate away from it.
      if (!this.listEl.win.getSelection()?.isCollapsed) return;
      evt.preventDefault();
      const href = link.getAttribute("data-href") ?? link.getAttribute("href");
      if (href) void this.app.workspace.openLinkText(href, "", false);
    });

    this.tailBtn = listWrap.createEl("button", {
      cls: "covault-ask-tail",
      attr: { "aria-label": "Jump to the latest" },
    });
    setIcon(this.tailBtn, "chevron-down");
    this.tailBtn.onclick = () => {
      this.followTail = true;
      this.listEl.scrollTop = this.listEl.scrollHeight;
      this.applyTailBtn();
    };

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
        // Whatever is queued was asked on the strength of an answer the
        // reader just stopped — firing it straight after would read as
        // having ignored them. It waits instead.
        if (this.queue.length > 0) this.queuePaused = true;
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
    this.closing = true;
    this.queue = [];
    this.running?.abort();
    // Takes the conversation's background commands with it: a detached
    // pipeline whose chat is gone has no one left to tell.
    this.engine.dispose();
  }

  /**
   * A background command finished while nothing was running.
   *
   * It joins the queue rather than barging in, so it lands in the same
   * order the reader already sees pending questions in — and so a queue
   * they paused with Esc stays paused. Idle, the queue drains at once,
   * which is the wake-up itself.
   */
  private onBackgroundWake(note: string): void {
    if (this.closing) return;
    this.queue.push({ question: note, images: [], kind: "wake" });
    this.followTail = true;
    if (!this.running && !this.queuePaused) {
      this.drainQueue();
      return;
    }
    this.renderTurns();
    this.renderHint();
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
    this.queue = [];
    this.queuePaused = false;
    this.session = this.freshSession();
    this.showSessions = false;
    this.renderAttachments();
    this.renderTurns();
    this.renderHint();
    this.refreshHeader();
  }

  private openSession(saved: ChatSession): void {
    // Two views on one conversation would each hold their own copy of it
    // and overwrite the other's turns on save. Go to the one that has it.
    const elsewhere = this.app.workspace
      .getLeavesOfType(COVAULT_ASK_VIEW_TYPE)
      .find((leaf) => leaf !== this.leaf && leaf.view instanceof AskView && leaf.view.session.id === saved.id);
    if (elsewhere) {
      void this.app.workspace.revealLeaf(elsewhere);
      new Notice(`Covault: "${saved.title}" is already open.`);
      return;
    }
    this.running?.abort();
    this.approved.clear();
    this.attached = [];
    this.queue = [];
    this.queuePaused = false;
    this.session = saved;
    this.engine.setTranscript(saved.transcript as Message[]);
    this.showSessions = false;
    this.renderAttachments();
    this.renderTurns();
    this.renderHint();
    this.refreshHeader();
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
      this.inputEl.removeClass("is-dragged");
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
    // the user dragged to is not autoGrow's business. The cap lives in a
    // stylesheet, so lifting it is a class — only the measured pixels are
    // written from here.
    this.inputEl.addClass("is-dragged");
    this.inputEl.setCssStyles({ height: `${height}px` });
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
    // Collapse before measuring: scrollHeight of an already-tall box
    // reports the box, not the text in it.
    el.setCssStyles({ height: "auto" });
    // Called once at build time too, when the leaf may not be laid out
    // yet — measuring then would pin the box to zero.
    if (el.scrollHeight === 0) return;
    const style = getComputedStyle(el);
    const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.setCssStyles({ height: `${el.scrollHeight + (Number.isFinite(borders) ? borders : 0)}px` });
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
    const queued = this.queue.length;
    // Between turns, a running command is the only reason the view looks
    // idle while work is still going on. Say so, or the wake-up that
    // arrives minutes later reads as the chat talking to itself — but say
    // it in two words on a line that is mostly keyboard hints. The
    // promise the note used to spell out is in its tooltip.
    const jobs = this.engine.runningJobs();
    if (jobs.length > 0) {
      const note = this.hintEl.createSpan("covault-ask-hint-job");
      setIcon(note.createSpan({ cls: "covault-ask-hint-job-icon" }), "loader");
      note.createSpan({
        cls: "covault-ask-hint-job-text",
        text: jobs.length === 1 ? `${jobs[0]!.id} running` : `${jobs.length} running`,
      });
      setTooltip(note, `${jobs.map((j) => `$ ${j.command}`).join("\n")}\nYou'll be told when it finishes.`, {
        delay: 300,
      });
    }
    if (this.running) {
      // Return no longer stops anything, so it has to say what it does now.
      key("\u21a9", queued > 0 ? `queue (${queued} waiting)` : "queue");
      key("Esc", "stop");
      return;
    }
    if (this.queuePaused && queued > 0) {
      key("\u21a9", `send the next of ${queued}`);
      return;
    }
    key("\u21a9", "send");
    key(`${MOD_KEY}\u21a9`, "new line");
  }

  /**
   * What Return does. Idle it asks; mid-answer it queues, because the one
   * thing it must not do is disturb the turn that is running — that used
   * to be an abort, which meant a follow-up thought cost you the answer
   * you were waiting for.
   */
  private submit(): void {
    const question = this.inputEl.value.trim();
    const images = this.attached;
    // An image on its own is a question ("what is this?"); text is only
    // required when there is nothing else to go on.
    if (!question && images.length === 0) {
      // Return on an empty box is how a queue that Esc paused gets going
      // again — no separate button for a state that rarely happens.
      if (this.queuePaused && this.queue.length > 0) this.drainQueue();
      return;
    }

    if (!this.engine.isEnabled()) {
      this.statusEl.setText("Set up an AI provider and key first (Settings → Covault → AI engine).");
      return;
    }

    // Cleared on the way in either way: the question has left the box, and
    // where it went is shown in the transcript.
    this.inputEl.value = "";
    this.autoGrow();
    this.attached = [];
    this.renderAttachments();

    if (this.running) {
      this.queue.push({ question, images });
      this.queuePaused = false;
      this.followTail = true;
      this.renderTurns();
      this.renderHint();
      return;
    }
    void this.runTurn(question, images);
  }

  /** Send the next queued question, if the queue is live. */
  private drainQueue(): void {
    if (this.running) return; // one turn at a time — the engine has one agent
    this.queuePaused = false;
    const next = this.queue.shift();
    if (!next) {
      this.renderHint();
      return;
    }
    void this.runTurn(next.question, next.images, next.kind);
  }

  private async runTurn(question: string, images: PastedImage[], kind?: ChatTurn["kind"]): Promise<void> {
    const turn: ChatTurn = { question, activity: [], ...(kind ? { kind } : {}) };
    if (images.length > 0) {
      // Write the bytes out now: the turn survives in chats.json, which
      // only ever holds the file names.
      turn.images = images.map((image, i) => this.store.attachments.save(this.session.id, image, i));
    }
    this.session.turns.push(turn);
    if (this.session.turns.length === 1) {
      this.session.title = titleFor(question || `${images.length} image${images.length === 1 ? "" : "s"}`);
    }
    this.showSessions = false;
    this.followTail = true;
    this.renderTurns();

    this.running = new AbortController();
    const { signal } = this.running;
    this.renderHint();
    this.refreshHeader();
    this.statusEl.setText("Thinking… (Esc to stop)");
    try {
      const answer = await this.engine.ask(
        question || "What do you make of this?",
        {
          signal: this.running.signal,
          onDelta: (text) => {
            this.statusEl.setText("Writing… (Esc to stop)");
            this.streamAnswer(text);
          },
          onActivity: (line) => {
            turn.activity.push(line);
            this.statusEl.setText(line);
            this.streamActivity(turn);
          },
          approve: (request) => this.approveAction(request),
        },
        images,
      );
      turn.answer = answer.text;
    } catch (e) {
      turn.error = (e as Error).message;
    } finally {
      this.running = null;
      // The answer is real now; the streamed copy of it must not survive
      // into the repaint below, or a deferred one would restore it.
      this.livePartial = "";
      this.liveEl = null;
      this.liveSteps = null;
      this.renderHint();
      this.refreshHeader();
      this.statusEl.setText("");
      this.persist();
      this.renderTurns();
      this.renderMcpChips();
      // Answered while the reader was in another tab or window: the whole
      // point of running these in parallel is not having to watch them.
      // Not for a turn they stopped themselves, and not for a view on its
      // way out — closing one aborts its turn, which is not news.
      if (!this.closing && !signal.aborted && !this.containerEl.isShown()) {
        new Notice(`Covault: "${this.session.title}" — ${turn.error ? "couldn't finish" : "answer ready"}.`);
      }
      // A job can finish during the wrap-up above, while `running` still
      // says a turn is in flight — its wake-up would then sit in the
      // queue with nothing coming to drain it.
      if (!this.queuePaused) this.drainQueue();
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

  /**
   * Rebuilds the list — which happens on every streamed chunk — without
   * moving the reader. Only the tail grows, so the offset they were at
   * still points at the same text.
   */
  /**
   * Rebuild the transcript.
   *
   * Held back while the reader has text selected in it: this empties the
   * list, and a selection whose nodes have been deleted is a selection
   * gone. The repaint is not dropped — releasing the selection runs it.
   */
  private renderTurns(): void {
    if (this.hasHeldSelection()) {
      this.repaintPending = true;
      return;
    }
    this.repaintPending = false;
    const prevTop = this.listEl.scrollTop;
    this.rebuilding = true;
    try {
      this.paintTurns();
    } finally {
      this.listEl.scrollTop = this.showSessions
        ? 0
        : this.followTail
          ? this.listEl.scrollHeight
          : prevTop;
      this.rebuilding = false;
      this.applyTailBtn();
    }
  }

  /** Has the reader scrolled away from the tail? A few pixels of rounding
   *  must not count as away. */
  private onListScroll(): void {
    if (this.rebuilding) return;
    const el = this.listEl;
    this.followTail = el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_SLACK_PX;
    this.applyTailBtn();
  }

  private applyTailBtn(): void {
    this.tailBtn?.toggleClass("is-visible", !this.followTail && !this.showSessions);
  }

  private paintTurns(): void {
    this.listEl.empty();
    this.liveEl = null;
    this.liveSteps = null;
    const partial = this.livePartial;
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
      if (turn.kind === "wake") this.renderWake(turn.question);
      else if (turn.question) this.listEl.createDiv({ cls: "covault-ask-q", text: turn.question });

      const isLive = i === last && this.running !== null;
      if (turn.activity.length > 0) {
        const steps = this.renderActivity(turn, i);
        if (isLive) this.liveSteps = steps;
      }

      if (turn.answer !== undefined) {
        this.renderAnswer(turn);
      } else if (turn.error !== undefined) {
        this.listEl.createDiv({ cls: "covault-ask-err", text: turn.error });
      } else if (isLive) {
        this.liveEl = this.listEl.createDiv({ cls: "covault-ask-a covault-ask-pending", text: partial || "…" });
      }
    });
    this.paintQueue();
  }

  /**
   * Queued questions sit where they will appear once sent — sending them
   * only turns the ink solid, nothing jumps. Each can be dropped while it
   * waits; a paused queue says so, because otherwise a queue that stopped
   * moving looks broken.
   */
  private paintQueue(): void {
    for (const item of this.queue) {
      const row = this.listEl.createDiv(
        `covault-ask-q covault-ask-queued${this.queuePaused ? " is-paused" : ""}`,
      );
      setIcon(row.createSpan({ cls: "covault-ask-queued-icon" }), this.queuePaused ? "pause" : "clock");
      // A wake-up's text is a whole log tail; one line of it is the news.
      const label = item.kind === "wake" ? firstLine(item.question) : item.question;
      row.createSpan({ cls: "covault-ask-queued-text", text: label || `${item.images.length} image(s)` });
      const drop = row.createEl("button", {
        cls: "covault-ask-queued-drop",
        attr: { "aria-label": "Remove from the queue" },
      });
      setIcon(drop, "x");
      drop.onclick = () => {
        // By identity, not by index: a turn finishing between the paint
        // and the click shifts the queue out from under `i`.
        const at = this.queue.indexOf(item);
        if (at >= 0) this.queue.splice(at, 1);
        this.renderTurns();
        this.renderHint();
      };
    }
  }

  /**
   * A background command reporting back — not a question, so it must not
   * look like one. The headline is the verdict ("bg1 finished with exit
   * code 0 after 4m12s"); the output it carried is one click away, for
   * the reader who wants to see what the model saw.
   */
  private renderWake(note: string): void {
    const details = this.listEl.createEl("details", { cls: "covault-ask-wake" });
    const summary = details.createEl("summary");
    setIcon(summary.createSpan({ cls: "covault-ask-wake-icon" }), "bell");
    summary.createSpan({ text: firstLine(note).replace(/^\[background\]\s*/, "") });
    details.createEl("pre", { cls: "covault-ask-wake-body", text: note });
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

  /**
   * "n steps", closed, whether or not the turn is still running. Live, it
   * used to print every step as its own line, and a list growing under
   * the text you were reading is what made the view impossible to read.
   * Nothing is lost: the step happening right now is in the status line.
   */
  private renderActivity(turn: ChatTurn, index: number): HTMLElement {
    const details = this.listEl.createEl("details", { cls: "covault-ask-steps" });
    if (this.stepsOpen.has(index)) details.setAttribute("open", "");
    details.addEventListener("toggle", () => {
      if (details.open) this.stepsOpen.add(index);
      else this.stepsOpen.delete(index);
    });
    details.createEl("summary", { text: stepCount(turn.activity.length) });
    for (const line of turn.activity) details.createDiv({ cls: "covault-ask-activity", text: line });
    return details;
  }

  /**
   * A streamed chunk, written into the answer already on screen.
   *
   * The text arrives cumulative, so the common case is appending to the
   * one text node that is already there — which leaves a selection
   * anchored earlier in that node intact, where setting the whole text
   * would replace the node and drop it. Anything else (a model that
   * rewrote what it had said, a node that is gone) falls back to a full
   * repaint, which the selection guard may then hold.
   */
  private streamAnswer(text: string): void {
    this.livePartial = text;
    // A repaint waiting on a selection that has since been let go: run it
    // now, so the chunk below is appended to the fresh nodes.
    this.flushRepaint();
    const el = this.liveEl;
    const node = el?.firstChild;
    if (!el?.isConnected || !node || node.nodeType !== Node.TEXT_NODE) {
      this.renderTurns();
      return;
    }
    const shown = node.nodeValue ?? "";
    if (shown === "…" || !text.startsWith(shown)) el.setText(text);
    else if (text.length > shown.length) (node as Text).appendData(text.slice(shown.length));
    this.keepAtTail();
  }

  /** The same trick for the step list: one line appended, one count
   *  rewritten, nothing else in the transcript touched. */
  private streamActivity(turn: ChatTurn): void {
    this.flushRepaint();
    const steps = this.liveSteps;
    if (!steps?.isConnected) {
      // No list yet — the first step is what creates it.
      this.renderTurns();
      return;
    }
    steps.find("summary")?.setText(stepCount(turn.activity.length));
    steps.createDiv({ cls: "covault-ask-activity", text: turn.activity[turn.activity.length - 1] });
    this.keepAtTail();
  }

  /** Follow the tail as text arrives — unless the reader is selecting,
   *  when moving the text out from under the cursor is the whole
   *  complaint. */
  private keepAtTail(): void {
    if (!this.followTail || this.hasHeldSelection()) return;
    this.rebuilding = true;
    this.listEl.scrollTop = this.listEl.scrollHeight;
    this.rebuilding = false;
  }

  /** Run a held-back repaint once the selection it was waiting on is
   *  gone. Cheap enough to call from anywhere; does nothing when there is
   *  nothing waiting. */
  private flushRepaint(): void {
    if (this.repaintPending && !this.hasHeldSelection()) this.renderTurns();
  }

  /** Is the reader holding a selection inside the transcript? Read from
   *  the list's own window, which is not the main one when Ask is in a
   *  popout. */
  private hasHeldSelection(): boolean {
    const sel = this.listEl.win.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    return this.listEl.contains(sel.getRangeAt(0).commonAncestorContainer);
  }

  private renderAnswer(turn: ChatTurn): void {
    const wrap = this.listEl.createDiv("covault-ask-a");
    const body = wrap.createDiv("covault-ask-md");
    void MarkdownRenderer.render(this.app, turn.answer ?? "", body, "", this);

    const foot = wrap.createDiv("covault-ask-foot");
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

import { ItemView, MarkdownRenderer, Notice, TFile, setIcon, type WorkspaceLeaf } from "obsidian";
import type CovaultPlugin from "../main";
import { AutomationDesigner } from "../automation/designer";
import { describeSchedule } from "../automation/schedule";
import type { Automation, RunLog } from "../automation/store";
import { ConfirmModal } from "./ConfirmModal";

export const COVAULT_AUTOMATION_VIEW_TYPE = "covault-automations";

interface ChatTurn {
  role: "user" | "assistant" | "error";
  text: string;
}

function relative(at: number, now = Date.now()): string {
  const diff = at - now;
  const abs = Math.abs(diff);
  const unit =
    abs < 60_000
      ? "less than a minute"
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)} min`
        : abs < 86_400_000
          ? `${Math.round(abs / 3_600_000)} h`
          : `${Math.round(abs / 86_400_000)} d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

/**
 * The Automations tab: the list of scheduled jobs (each expandable to its
 * instructions and run log) beside a conversation that sets them up.
 *
 * The list re-renders on every runner change; the chat is left alone so
 * a refresh never eats what the user is typing.
 */
export class AutomationView extends ItemView {
  private designer: AutomationDesigner;
  private chat: ChatTurn[] = [];
  private expanded = new Set<string>();
  private expandedRuns = new Set<string>();
  private listEl!: HTMLElement;
  private chatListEl!: HTMLElement;
  private activityEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private liveEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: CovaultPlugin,
  ) {
    super(leaf);
    this.designer = plugin.newAutomationDesigner();
  }

  getViewType(): string {
    return COVAULT_AUTOMATION_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Automations";
  }
  getIcon(): string {
    return "alarm-clock";
  }

  onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("covault-auto");

    const left = root.createDiv("covault-auto-col covault-auto-list-col");
    const head = left.createDiv("covault-auto-head");
    head.createSpan({ cls: "covault-auto-title", text: "Automations" });
    head.createSpan({
      cls: "covault-auto-hint",
      text: "Runs while Obsidian is open on this computer.",
    });
    this.listEl = left.createDiv("covault-auto-list");

    const right = root.createDiv("covault-auto-col covault-auto-chat-col");
    const chatHead = right.createDiv("covault-auto-head");
    chatHead.createSpan({ cls: "covault-auto-title", text: "Set up by chat" });
    const reset = chatHead.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "New conversation" } });
    setIcon(reset, "rotate-ccw");
    reset.onclick = () => {
      this.designer.reset();
      this.chat = [];
      this.renderChat();
    };
    this.chatListEl = right.createDiv("covault-auto-chat");
    this.activityEl = right.createDiv("covault-auto-activity");
    const composer = right.createDiv("covault-auto-composer");
    this.inputEl = composer.createEl("textarea", {
      attr: { rows: "3", placeholder: "Describe a task, for example: every morning at 9, summarize yesterday's changes in the team libraries into a daily digest note" },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      }
    });
    this.sendBtn = composer.createEl("button", { cls: "mod-cta", text: "Send" });
    this.sendBtn.onclick = () => (this.designer.isBusy() ? this.designer.abort() : void this.send());

    this.renderList();
    this.renderChat();
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    this.designer.reset();
    return Promise.resolve();
  }

  // ── List ───────────────────────────────────────────────────

  /** Called by the plugin whenever automations or their runs change. */
  refresh(): void {
    if (this.listEl) this.renderList();
  }

  private renderList(): void {
    const el = this.listEl;
    el.empty();
    const all = this.plugin.automations.list();
    if (all.length === 0) {
      el.createDiv({
        cls: "covault-auto-empty",
        text: "No automations yet. Describe what you'd like done on a schedule in the chat, and it will be set up here.",
      });
      return;
    }
    for (const a of all) this.renderCard(el, a);
  }

  private renderCard(parent: HTMLElement, a: Automation): void {
    const runner = this.plugin.automationRunner;
    const runs = this.plugin.automations.runs(a.id);
    const last = runs[0];
    const running = runner.isRunning(a.id);
    const card = parent.createDiv(`covault-auto-card${a.enabled ? "" : " is-paused"}`);

    const row = card.createDiv("covault-auto-card-row");
    const open = this.expanded.has(a.id);
    const chevron = row.createSpan("covault-auto-chevron");
    setIcon(chevron, open ? "chevron-down" : "chevron-right");
    const state = running ? "running" : (last?.status ?? "never");
    row.createSpan({ cls: `covault-auto-dot is-${state}`, attr: { "aria-label": running ? "Running" : last ? `Last run: ${last.status}` : "Never run" } });

    const info = row.createDiv("covault-auto-info");
    info.createDiv({ cls: "covault-auto-name", text: a.name });
    const next = runner.nextRunAt(a);
    const meta = [
      describeSchedule(a.schedule),
      running ? "running now…" : a.enabled && next ? `next ${relative(next)}` : "paused",
      last ? `last ${relative(last.at)}` : "never run",
    ];
    info.createDiv({ cls: "covault-auto-meta", text: meta.join(" · ") });

    const actions = row.createDiv("covault-auto-actions");
    const toggle = actions.createEl("input", { type: "checkbox", attr: { "aria-label": a.enabled ? "Pause" : "Resume" } });
    toggle.checked = a.enabled;
    toggle.onclick = (e) => e.stopPropagation();
    toggle.onchange = () => {
      // Resuming counts from now: no replaying the slots it slept through.
      this.plugin.automations.update(a.id, toggle.checked ? { enabled: true, lastSlotAt: Date.now() } : { enabled: false });
      this.refresh();
    };
    const runBtn = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Run now" } });
    setIcon(runBtn, running ? "loader" : "play");
    runBtn.disabled = running;
    runBtn.onclick = (e) => {
      e.stopPropagation();
      void runner.runNow(a.id, "manual");
    };
    const del = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Delete" } });
    setIcon(del, "trash-2");
    del.onclick = async (e) => {
      e.stopPropagation();
      const ok = await ConfirmModal.ask(this.app, {
        title: "Delete automation",
        message: `Delete "${a.name}" and its run log? Notes it already wrote stay.`,
        cta: "Delete",
      });
      if (!ok) return;
      this.plugin.automations.remove(a.id);
      this.refresh();
    };

    row.onclick = () => {
      if (open) this.expanded.delete(a.id);
      else this.expanded.add(a.id);
      this.refresh();
    };

    if (!open) return;
    const body = card.createDiv("covault-auto-body");
    const instr = body.createEl("details", { cls: "covault-auto-instructions" });
    instr.createEl("summary", { text: "Instructions" });
    instr.createEl("pre", { text: a.instructions });

    body.createDiv({ cls: "covault-auto-section", text: runs.length ? `Run log (${runs.length})` : "Run log" });
    if (runs.length === 0) {
      body.createDiv({ cls: "covault-auto-empty", text: running ? "First run in progress…" : "No runs yet." });
      return;
    }
    const log = body.createDiv("covault-auto-runs");
    for (const r of runs) this.renderRun(log, a, r);
  }

  private renderRun(parent: HTMLElement, a: Automation, r: RunLog): void {
    const key = `${a.id}:${r.at}`;
    const open = this.expandedRuns.has(key);
    const item = parent.createDiv(`covault-auto-run is-${r.status}`);
    const line = item.createDiv("covault-auto-run-line");
    line.createSpan({ cls: `covault-auto-badge is-${r.status}`, text: r.status === "ok" ? "Done" : r.status === "error" ? "Failed" : "Skipped" });
    line.createSpan({ cls: "covault-auto-run-time", text: new Date(r.at).toLocaleString() });
    const bits = [r.trigger === "manual" ? "run by hand" : "scheduled"];
    if (r.status !== "skipped") bits.push(`${(r.ms / 1000).toFixed(0)}s`);
    if (r.changed.length) bits.push(`${r.changed.length} note(s) changed`);
    line.createSpan({ cls: "covault-auto-run-meta", text: bits.join(" · ") });
    line.onclick = () => {
      if (open) this.expandedRuns.delete(key);
      else this.expandedRuns.add(key);
      this.refresh();
    };
    if (!open) return;

    const detail = item.createDiv("covault-auto-run-detail");
    const report = detail.createDiv("covault-auto-report markdown-rendered");
    void MarkdownRenderer.render(this.app, r.summary, report, "", this);
    if (r.changed.length) {
      const changed = detail.createDiv("covault-auto-changed");
      changed.createSpan({ text: "Changed: " });
      for (const p of r.changed) {
        const link = changed.createEl("a", { text: p, cls: "covault-auto-link" });
        link.onclick = () => {
          const file = this.app.vault.getAbstractFileByPath(p);
          if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
          else new Notice(`Covault: ${p} no longer exists.`);
        };
      }
    }
    if (r.tools.length) {
      const steps = detail.createEl("details", { cls: "covault-auto-steps" });
      steps.createEl("summary", { text: `${r.tools.length} step(s)` });
      const ul = steps.createEl("ul");
      for (const t of r.tools) {
        ul.createEl("li", { text: `${t.name}${t.summary ? ` — ${t.summary}` : ""}${t.isError ? " (failed)" : ""}` });
      }
    }
  }

  // ── Chat ───────────────────────────────────────────────────

  private renderChat(): void {
    const el = this.chatListEl;
    el.empty();
    this.liveEl = null;
    if (this.chat.length === 0) {
      const empty = el.createDiv("covault-auto-empty");
      empty.setText(
        this.plugin.automationModelReady()
          ? "Tell me what you'd like automated and how often (every few hours, or daily at a set time). I'll draft it, show you the plan, and set it up once you agree."
          : "Set up an AI model first (Settings → Covault → AI engine) — automations and this chat both run on it.",
      );
      return;
    }
    for (const turn of this.chat) {
      const bubble = el.createDiv(`covault-auto-msg is-${turn.role}`);
      if (turn.role === "assistant") void MarkdownRenderer.render(this.app, turn.text, bubble, "", this);
      else bubble.setText(turn.text);
    }
    el.scrollTop = el.scrollHeight;
  }

  private async send(): Promise<void> {
    const message = this.inputEl.value.trim();
    if (!message || this.designer.isBusy()) return;
    this.inputEl.value = "";
    this.chat.push({ role: "user", text: message });
    this.renderChat();
    this.liveEl = this.chatListEl.createDiv("covault-auto-msg is-assistant is-pending");
    this.liveEl.setText("…");
    this.sendBtn.setText("Stop");
    try {
      const reply = await this.designer.send(message, {
        onText: (partial) => {
          if (this.liveEl && partial) {
            this.liveEl.setText(partial);
            this.chatListEl.scrollTop = this.chatListEl.scrollHeight;
          }
        },
        onActivity: (line) => this.activityEl.setText(line),
      });
      this.chat.push({ role: "assistant", text: reply || "(no reply)" });
    } catch (e) {
      this.chat.push({ role: "error", text: (e as Error).message });
    } finally {
      this.activityEl.setText("");
      this.sendBtn.setText("Send");
      this.renderChat();
      this.refresh();
    }
  }
}

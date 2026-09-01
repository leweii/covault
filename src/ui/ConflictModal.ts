import { Modal, Notice, setIcon, type App } from "obsidian";
import type { AISuggestion, AISuggestResult, ConflictResolver } from "../llm/resolver";
import {
  parseConflict,
  applyResolutions,
  extractHunks,
  isFullyResolved,
  getContextLines,
  type ConflictHunk,
  type ConflictSegment,
  type HunkResolution,
} from "../sync/ConflictParser";

/** File/merge operations bound to one repo — the modal stays git-free. */
export interface ConflictOps {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Stage the resolved files, create the merge commit, push. */
  finishMerge(paths: string[], message: string): Promise<void>;
  /** Drop the half-done merge and go back to the local version. */
  abortMerge(): Promise<void>;
}

type AIHunkState =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "result"; suggestion: AISuggestion; providerName: string }
  | { kind: "error"; message: string };

interface FileState {
  path: string;
  segments: ConflictSegment[];
  hunks: ConflictHunk[];
  resolutions: Map<string, HunkResolution>;
  aiByHunk: Map<string, AIHunkState>;
  persisted: boolean;
}

/** Three-pane conflict resolution (local | remote | AI/edit), ported from
 *  agentic-git-sync's ConflictModal v2. */
export class ConflictModal extends Modal {
  private files: FileState[] = [];
  private currentFile = 0;
  private currentHunk = 0;
  private editMode = false;
  private editText = "";

  constructor(
    app: App,
    private ops: ConflictOps,
    private conflictPaths: string[],
    private onResolved: () => void,
    private repoLabel: string,
    private resolver: ConflictResolver | null,
  ) {
    super(app);
    this.modalEl.addClass("covault-cv2-modal");
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createDiv({ cls: "covault-cv2-loading", text: "Loading conflicts…" });
    await this.loadFiles();
    this.render();
    this.maybeTriggerAI();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // ── Loading ───────────────────────────────────────────────

  private async loadFiles(): Promise<void> {
    this.files = [];
    for (const path of this.conflictPaths) {
      try {
        const content = await this.ops.readFile(path);
        const segments = parseConflict(content);
        const hunks = extractHunks(segments);
        if (hunks.length === 0) continue;
        this.files.push({ path, segments, hunks, resolutions: new Map(), aiByHunk: new Map(), persisted: false });
      } catch (e) {
        new Notice(`Covault: couldn't load ${path} — ${(e as Error).message}`);
      }
    }
  }

  // ── State helpers ─────────────────────────────────────────

  private file(): FileState {
    return this.files[this.currentFile]!;
  }
  private hunk(): ConflictHunk {
    return this.file().hunks[this.currentHunk]!;
  }
  private aiState(): AIHunkState {
    return this.file().aiByHunk.get(this.hunk().id) ?? { kind: "idle" };
  }
  private fileResolved(f: FileState): boolean {
    return isFullyResolved(f.segments, f.resolutions);
  }
  private allResolved(): boolean {
    return this.files.every((f) => this.fileResolved(f));
  }

  private fileStatus(f: FileState, idx: number): "current" | "clean" | "partial" | "unresolved" {
    if (idx === this.currentFile) return "current";
    const done = f.hunks.filter((h) => {
      const r = f.resolutions.get(h.id);
      return r && r.kind !== "skip";
    }).length;
    if (done === f.hunks.length) return "clean";
    if (done > 0) return "partial";
    return "unresolved";
  }

  private totalHunks(): number {
    return this.files.reduce((s, f) => s + f.hunks.length, 0);
  }

  private resolvedHunks(): number {
    return this.files.reduce(
      (s, f) =>
        s +
        f.hunks.filter((h) => {
          const r = f.resolutions.get(h.id);
          return r && r.kind !== "skip";
        }).length,
      0,
    );
  }

  // ── AI orchestration ──────────────────────────────────────

  private aiAvailable(): boolean {
    return !!this.resolver && this.resolver.isEnabled();
  }

  private maybeTriggerAI(): void {
    if (!this.aiAvailable() || this.files.length === 0) return;
    const file = this.file();
    const hunk = this.hunk();
    const existing = file.aiByHunk.get(hunk.id);
    if (existing && existing.kind !== "idle") return;
    this.triggerAI(file, hunk);
  }

  private triggerAI(file: FileState, hunk: ConflictHunk): void {
    if (!this.resolver) return;
    file.aiByHunk.set(hunk.id, { kind: "thinking" });
    const stillCurrent = () => this.files[this.currentFile] === file && this.hunk()?.id === hunk.id;
    if (stillCurrent()) this.render();

    const ctx = getContextLines(file.segments, hunk.id, 10);
    this.resolver
      .suggest({ filePath: file.path, hunk: { local: hunk.local, remote: hunk.remote }, context: ctx })
      .then((result: AISuggestResult) => {
        file.aiByHunk.set(hunk.id, { kind: "result", suggestion: result.suggestion, providerName: result.providerName });
        if (stillCurrent()) this.render();
      })
      .catch((e: Error) => {
        file.aiByHunk.set(hunk.id, { kind: "error", message: e.message });
        if (stillCurrent()) this.render();
      });
  }

  private retryAI(): void {
    this.file().aiByHunk.delete(this.hunk().id);
    this.maybeTriggerAI();
  }

  // ── Render ────────────────────────────────────────────────

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    if (this.files.length === 0) {
      const empty = contentEl.createDiv("covault-cv2-empty");
      empty.createEl("p", { text: "No conflict markers found." });
      empty.createEl("p", {
        cls: "covault-cv2-empty-sub",
        text: "The notes may already be clean — another sync or an earlier edit could have resolved them.",
      });
      const actions = empty.createDiv("covault-cv2-empty-actions");
      const abortBtn = actions.createEl("button", { text: "Discard merge state" });
      abortBtn.onclick = async () => {
        abortBtn.disabled = true;
        try {
          await this.ops.abortMerge();
          new Notice("Covault: cleaned up.");
        } catch (e) {
          new Notice(`Covault: cleanup failed — ${(e as Error).message}`, 8000);
        }
        this.onResolved();
        this.close();
      };
      const closeBtn = actions.createEl("button", { text: "Close", cls: "mod-cta" });
      closeBtn.onclick = () => {
        this.onResolved();
        this.close();
      };
      return;
    }

    if (this.allResolved()) {
      this.renderSummary();
      return;
    }

    const root = contentEl.createDiv("covault-cv2-root");
    this.renderHeader(root);
    const body = root.createDiv("covault-cv2-body");
    this.renderFilesPane(body);
    this.renderMainPane(body);
    this.renderFooter(root);
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv("covault-cv2-header");
    const top = header.createDiv("covault-cv2-header-top");
    const titleWrap = top.createDiv("covault-cv2-title");
    if (!this.allResolved()) {
      titleWrap.createSpan({ cls: "covault-cv2-title-prefix", text: "Conflicts · " });
      titleWrap.createSpan({ cls: "covault-cv2-filename", text: this.file().path });
      if (this.editMode) titleWrap.createSpan({ cls: "covault-cv2-edit-badge", text: "editing" });
    } else {
      titleWrap.createSpan({ cls: "covault-cv2-filename", text: `All ${this.files.length} file(s) resolved` });
    }
    top.createDiv({ cls: "covault-cv2-spacer" });
    // (Obsidian's own modal close button lives in the top-right corner —
    // no second X of our own.)

    const meta = header.createDiv("covault-cv2-header-meta");
    meta.createSpan({ text: `Library: ${this.repoLabel}` });
    meta.createSpan({ cls: "covault-cv2-dot", text: "·" });
    meta.createSpan({ text: this.allResolved() ? "ready to merge" : "merge in progress" });
    if (this.aiAvailable() && !this.allResolved()) {
      meta.createSpan({ cls: "covault-cv2-dot", text: "·" });
      const aiTag = meta.createSpan({ cls: "covault-cv2-ai-tag" });
      const icon = aiTag.createSpan({ cls: "covault-cv2-ai-tag-icon" });
      setIcon(icon, "sparkles");
      aiTag.createSpan({ text: "AI assist on" });
    }
  }

  private renderFilesPane(parent: HTMLElement): void {
    const pane = parent.createDiv("covault-cv2-files-pane");
    pane.createEl("h4", { text: `${this.files.length} file(s)` });
    const list = pane.createDiv("covault-cv2-file-list");
    for (let i = 0; i < this.files.length; i++) {
      const f = this.files[i]!;
      const status = this.fileStatus(f, i);
      const row = list.createDiv(`covault-cv2-file-row ${status}`);
      const badge = row.createSpan({ cls: `covault-cv2-file-badge ${status}` });
      badge.setText(status === "clean" ? "✓" : status === "current" ? "●" : status === "partial" ? "◐" : "✗");
      row.createSpan({ cls: "covault-cv2-file-name", text: f.path });
      row.onclick = () => {
        if (this.editMode) {
          new Notice("Save or cancel your edit first.");
          return;
        }
        this.currentFile = i;
        this.currentHunk = 0;
        this.render();
        this.maybeTriggerAI();
      };
    }

    const legend = pane.createDiv("covault-cv2-legend");
    for (const [sym, label, cls] of [
      ["●", "current", "current"],
      ["✗", "unresolved", "unresolved"],
      ["◐", "partially done", "partial"],
      ["✓", "resolved", "clean"],
    ] as const) {
      const row = legend.createDiv("covault-cv2-legend-row");
      row.createSpan({ cls: `covault-cv2-file-badge ${cls}`, text: sym });
      row.createSpan({ text: label });
    }
  }

  private renderMainPane(parent: HTMLElement): void {
    const main = parent.createDiv("covault-cv2-main-pane");
    const ai = this.aiState();

    // Hunk nav
    const nav = main.createDiv("covault-cv2-hunk-nav");
    nav.createSpan({
      cls: "covault-cv2-hunk-label",
      text: `Conflict ${this.currentHunk + 1} of ${this.file().hunks.length}${this.editMode ? " — editing" : ""}`,
    });
    const navBtns = nav.createDiv("covault-cv2-nav-btns");
    const prev = navBtns.createEl("button", { cls: "covault-cv2-nav-btn", text: "← Prev" });
    prev.disabled = this.currentHunk === 0 || this.editMode;
    prev.onclick = () => {
      this.currentHunk--;
      this.render();
      this.maybeTriggerAI();
    };
    const next = navBtns.createEl("button", { cls: "covault-cv2-nav-btn", text: "Next →" });
    next.disabled = this.currentHunk >= this.file().hunks.length - 1 || this.editMode;
    next.onclick = () => {
      this.currentHunk++;
      this.render();
      this.maybeTriggerAI();
    };

    if (ai.kind === "result") {
      const conf = nav.createDiv("covault-cv2-confidence");
      conf.createSpan({ cls: "covault-cv2-conf-label", text: "AI confidence" });
      const dots = conf.createDiv("covault-cv2-conf-dots");
      for (let i = 0; i < 5; i++) {
        dots.createDiv({ cls: `covault-cv2-conf-dot ${i < ai.suggestion.confidence ? "on" : ""}` });
      }
      conf.createSpan({ cls: "covault-cv2-conf-text", text: confidenceLabel(ai.suggestion.confidence) });
      if (ai.suggestion.confidence <= 2) conf.addClass("low");
    } else {
      const tag = nav.createDiv("covault-cv2-resolution-tag");
      const r = this.file().resolutions.get(this.hunk().id);
      if (r && r.kind !== "skip") {
        tag.addClass("resolved");
        tag.setText(`✓ ${resolutionLabel(r.kind)}`);
      } else if (r?.kind === "skip") {
        tag.addClass("skipped");
        tag.setText("skipped");
      } else {
        tag.setText("unresolved");
      }
    }

    if (ai.kind === "result" && ai.suggestion.confidence <= 2) {
      const banner = main.createDiv("covault-cv2-low-conf-banner");
      const icon = banner.createSpan({ cls: "covault-cv2-banner-icon" });
      setIcon(icon, "alert-triangle");
      banner.createSpan({ cls: "covault-cv2-banner-title", text: "The AI isn't sure here." });
      banner.createSpan({ cls: "covault-cv2-banner-body", text: "Review both sides before accepting." });
    }

    // Three-pane diff
    const grid = main.createDiv("covault-cv2-diff-grid");
    const dim = ai.kind === "result";
    this.renderDiffPane(grid, "Yours", "local", this.hunk().local, dim);
    this.renderDiffPane(grid, "Teammate's", "remote", this.hunk().remote, dim);
    if (this.editMode) this.renderEditPane(grid);
    else this.renderAiPane(grid, ai);

    // Actions
    const actions = main.createDiv("covault-cv2-hunk-actions");
    if (this.editMode) {
      const cancelEdit = actions.createEl("button", { cls: "covault-cv2-ghost-btn", text: "Cancel" });
      cancelEdit.onclick = () => {
        this.editMode = false;
        this.render();
      };
      actions.createDiv({ cls: "covault-cv2-spacer" });
      const save = actions.createEl("button", { cls: "covault-cv2-action-btn primary", text: "Save edit" });
      save.onclick = () => this.commitEdit();
    } else {
      this.actionBtn(actions, "Keep yours", () => this.applyHunk({ kind: "local" }));
      this.actionBtn(actions, "Keep teammate's", () => this.applyHunk({ kind: "remote" }));
      const takeAi = actions.createEl("button", { cls: "covault-cv2-action-btn primary", text: "Use AI merge" });
      if (ai.kind === "result") {
        takeAi.createSpan({ cls: "covault-cv2-star-glyph", text: "★" });
        takeAi.onclick = () => this.applyHunk({ kind: "edit", text: ai.suggestion.merged.join("\n") });
      } else {
        takeAi.disabled = true;
        takeAi.title =
          ai.kind === "thinking"
            ? "AI is thinking…"
            : ai.kind === "error"
              ? "AI suggestion failed"
              : "Configure an AI provider in Settings";
      }
      this.actionBtn(actions, "Edit manually", () => this.enterEditMode());
      this.actionBtn(actions, "Skip", () => this.applyHunk({ kind: "skip" }), "covault-cv2-ghost-btn");
    }

    this.renderReasoning(main, ai);
  }

  private renderDiffPane(parent: HTMLElement, title: string, kind: "local" | "remote", lines: string[], dim: boolean): void {
    const pane = parent.createDiv(`covault-cv2-pane ${kind}${dim ? " dim" : ""}`);
    const header = pane.createDiv("covault-cv2-pane-header");
    header.createSpan({ cls: "covault-cv2-pane-title", text: title });
    const body = pane.createDiv("covault-cv2-pane-body");
    if (lines.length === 0) {
      body.createDiv({ cls: "covault-cv2-pane-placeholder", text: "(empty)" });
      return;
    }
    for (let i = 0; i < lines.length; i++) {
      const row = body.createDiv(`covault-cv2-line ${kind === "local" ? "del" : "add"}`);
      row.createSpan({ cls: "covault-cv2-lineno", text: String(i + 1) });
      row.createSpan({ cls: "covault-cv2-marker", text: kind === "local" ? "-" : "+" });
      row.createSpan({ cls: "covault-cv2-code", text: lines[i] ?? "" });
    }
  }

  private renderAiPane(parent: HTMLElement, state: AIHunkState): void {
    const pane = parent.createDiv("covault-cv2-pane ai");
    const header = pane.createDiv("covault-cv2-pane-header");
    const icon = header.createSpan({ cls: "covault-cv2-pane-icon" });
    setIcon(icon, "sparkles");
    header.createSpan({ cls: "covault-cv2-pane-title", text: "AI suggestion" });

    if (state.kind === "result") {
      header.createSpan({ cls: "covault-cv2-pane-meta", text: state.providerName });
      const body = pane.createDiv("covault-cv2-pane-body");
      const picks = new Set(state.suggestion.picks);
      for (let i = 0; i < state.suggestion.merged.length; i++) {
        const isPick = picks.has(i);
        const row = body.createDiv(`covault-cv2-line${isPick ? " ai-pick" : ""}`);
        row.createSpan({ cls: "covault-cv2-lineno", text: String(i + 1) });
        row.createSpan({ cls: "covault-cv2-marker", text: isPick ? "+" : " " });
        const codeCell = row.createSpan({ cls: "covault-cv2-code" });
        codeCell.setText(state.suggestion.merged[i] ?? "");
        if (isPick) codeCell.createSpan({ cls: "covault-cv2-star", text: " ★" });
      }
      return;
    }

    if (state.kind === "thinking") {
      header.createSpan({ cls: "covault-cv2-pane-meta", text: "thinking…" });
      const body = pane.createDiv("covault-cv2-pane-body covault-cv2-ai-thinking");
      const overlay = body.createDiv("covault-cv2-thinking-overlay");
      overlay.createDiv("covault-cv2-spinner");
      overlay.createDiv({ cls: "covault-cv2-thinking-text", text: "Generating a merge…" });
      for (let i = 0; i < 4; i++) {
        const line = body.createDiv("covault-cv2-skeleton-line");
        line.createSpan({ cls: "covault-cv2-lineno", text: String(i + 1) });
        const bar = line.createDiv("covault-cv2-skeleton-bar");
        bar.style.width = `${[42, 78, 64, 30][i] ?? 50}%`;
      }
      return;
    }

    if (state.kind === "error") {
      header.addClass("error");
      header.createSpan({ cls: "covault-cv2-pane-meta error-meta", text: "failed" });
      const body = pane.createDiv("covault-cv2-pane-body");
      const card = body.createDiv("covault-cv2-error-card");
      const cardHeader = card.createDiv("covault-cv2-error-card-header");
      const cardIcon = cardHeader.createSpan({ cls: "covault-cv2-error-icon" });
      setIcon(cardIcon, "alert-circle");
      cardHeader.createSpan({ text: "AI suggestion failed" });
      card.createDiv({ cls: "covault-cv2-error-card-body", text: truncate(state.message, 280) });
      const actions = card.createDiv("covault-cv2-error-card-actions");
      const retry = actions.createEl("button", { cls: "covault-cv2-action-btn", text: "Retry" });
      retry.onclick = () => this.retryAI();
      const fallback = actions.createEl("button", { cls: "covault-cv2-action-btn", text: "Resolve manually" });
      fallback.onclick = () => this.enterEditMode();
      return;
    }

    header.createSpan({ cls: "covault-cv2-pane-meta", text: "not configured" });
    const body = pane.createDiv("covault-cv2-pane-body covault-cv2-ai-empty");
    const emptyIcon = body.createDiv("covault-cv2-ai-empty-icon");
    setIcon(emptyIcon, "sparkles");
    body.createDiv({
      cls: "covault-cv2-ai-empty-text",
      text: "Set an AI provider and API key in Settings to get merge suggestions.",
    });
  }

  private renderEditPane(parent: HTMLElement): void {
    const pane = parent.createDiv("covault-cv2-pane edit");
    const header = pane.createDiv("covault-cv2-pane-header");
    const icon = header.createSpan({ cls: "covault-cv2-pane-icon" });
    setIcon(icon, "pencil");
    header.createSpan({ cls: "covault-cv2-pane-title", text: "Manual edit" });
    header.createSpan({ cls: "covault-cv2-pane-meta unsaved", text: "unsaved" });

    const ta = pane.createEl("textarea", { cls: "covault-cv2-edit-textarea" });
    ta.spellcheck = false;
    ta.value = this.editText;
    ta.oninput = () => {
      this.editText = ta.value;
    };
    window.setTimeout(() => ta.focus(), 0);
    ta.onkeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.commitEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.editMode = false;
        this.render();
      }
    };

    const hint = pane.createDiv({ cls: "covault-cv2-edit-hint" });
    hint.createEl("kbd", { text: "⌘ Enter" });
    hint.appendText(" save · ");
    hint.createEl("kbd", { text: "Esc" });
    hint.appendText(" cancel");
  }

  private renderReasoning(parent: HTMLElement, state: AIHunkState): void {
    const reasoning = parent.createDiv("covault-cv2-reasoning");
    const header = reasoning.createDiv("covault-cv2-reasoning-header");
    const icon = header.createSpan({ cls: "covault-cv2-reasoning-icon" });

    if (state.kind === "result") {
      setIcon(icon, "sparkles");
      header.createSpan({ text: "Why the AI merged it this way" });
      const list = reasoning.createEl("ul", { cls: "covault-cv2-reasoning-list" });
      for (const r of state.suggestion.reasoning) list.createEl("li", { text: r });
      // Which model merged it, and nothing about what it cost: usage is
      // between the user and their provider, not something this plugin
      // reports back at them.
      const info = reasoning.createDiv("covault-cv2-model-info");
      info.createSpan({ text: `model: ${state.suggestion.model}` });
      return;
    }

    if (state.kind === "thinking") {
      icon.appendChild(this.contentEl.createDiv("covault-cv2-spinner-sm"));
      header.createSpan({ text: "AI is analyzing this conflict…" });
      return;
    }

    if (state.kind === "error") {
      header.addClass("error");
      setIcon(icon, "alert-circle");
      header.createSpan({ text: "AI provider error" });
      reasoning.createEl("p", { cls: "covault-cv2-reasoning-body", text: truncate(state.message, 280) });
      return;
    }

    setIcon(icon, "sparkles");
    header.createSpan({ text: "AI assistance not configured" });
  }

  private renderFooter(root: HTMLElement): void {
    const footer = root.createDiv("covault-cv2-footer");
    footer.createDiv({
      cls: "covault-cv2-progress",
      text: `${this.resolvedHunks()} / ${this.totalHunks()} conflicts resolved`,
    });
    footer.createDiv({ cls: "covault-cv2-spacer" });

    const abort = footer.createEl("button", { cls: "covault-cv2-ghost-btn", text: "Discard merge" });
    abort.onclick = () => this.abort();
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const next = footer.createEl("button", {
      cls: "mod-cta",
      text: this.lastUnresolvedFile() ? "Save & finish" : "Save & next file",
    });
    next.disabled = !this.fileResolved(this.file());
    next.onclick = () => this.saveAndAdvance();
  }

  private lastUnresolvedFile(): boolean {
    return this.files.filter((f, i) => i !== this.currentFile && !this.fileResolved(f)).length === 0;
  }

  // ── Summary state ─────────────────────────────────────────

  private renderSummary(): void {
    const root = this.contentEl.createDiv("covault-cv2-root");
    this.renderHeader(root);
    const body = root.createDiv("covault-cv2-body");
    this.renderFilesPane(body);

    const summary = body.createDiv("covault-cv2-summary");
    const iconWrap = summary.createDiv("covault-cv2-summary-icon");
    setIcon(iconWrap, "check");
    summary.createEl("h3", { text: "All conflicts resolved" });
    summary.createEl("p", {
      cls: "covault-cv2-summary-subtitle",
      text: `${this.files.length} file(s), ${this.totalHunks()} conflict(s) — ready to merge and share.`,
    });

    const aiCount = this.countAIPicks();
    const stats = summary.createDiv("covault-cv2-summary-stats");
    this.statCard(stats, String(this.totalHunks()), "resolved", "green");
    this.statCard(stats, String(this.countByKind("local") + this.countByKind("remote")), "picked a side", "");
    this.statCard(stats, String(aiCount), "AI merged", "accent");
    this.statCard(stats, String(this.countByKind("edit") - aiCount), "hand-edited", "");

    const footer = root.createDiv("covault-cv2-footer");
    footer.createDiv({ cls: "covault-cv2-spacer" });
    const closeBtn = footer.createEl("button", { text: "Close" });
    closeBtn.onclick = () => this.close();
    const mergeBtn = footer.createEl("button", { cls: "mod-cta", text: "Merge & share" });
    mergeBtn.onclick = () => this.finish(mergeBtn);
  }

  private statCard(parent: HTMLElement, num: string, label: string, cls: string): void {
    const card = parent.createDiv("covault-cv2-stat");
    card.createDiv({ cls: `covault-cv2-stat-num ${cls}`, text: num });
    card.createDiv({ cls: "covault-cv2-stat-label", text: label });
  }

  private countByKind(kind: HunkResolution["kind"]): number {
    let n = 0;
    for (const f of this.files) for (const r of f.resolutions.values()) if (r.kind === kind) n++;
    return n;
  }

  private countAIPicks(): number {
    let n = 0;
    for (const f of this.files) {
      for (const h of f.hunks) {
        const ai = f.aiByHunk.get(h.id);
        const r = f.resolutions.get(h.id);
        if (ai?.kind === "result" && r?.kind === "edit" && r.text === ai.suggestion.merged.join("\n")) n++;
      }
    }
    return n;
  }

  // ── Actions ───────────────────────────────────────────────

  private actionBtn(parent: HTMLElement, label: string, onClick: () => void, extraCls?: string): HTMLButtonElement {
    const btn = parent.createEl("button", { cls: `covault-cv2-action-btn ${extraCls ?? ""}`.trim(), text: label });
    btn.onclick = onClick;
    return btn;
  }

  private applyHunk(r: HunkResolution): void {
    this.file().resolutions.set(this.hunk().id, r);
    if (this.currentHunk < this.file().hunks.length - 1) this.currentHunk++;
    this.render();
    this.maybeTriggerAI();
  }

  private enterEditMode(): void {
    const existing = this.file().resolutions.get(this.hunk().id);
    const ai = this.aiState();
    if (existing && existing.kind === "edit") this.editText = existing.text;
    else if (ai.kind === "result") this.editText = ai.suggestion.merged.join("\n");
    else this.editText = this.hunk().local.join("\n");
    this.editMode = true;
    this.render();
  }

  private commitEdit(): void {
    this.file().resolutions.set(this.hunk().id, { kind: "edit", text: this.editText });
    this.editMode = false;
    if (this.currentHunk < this.file().hunks.length - 1) this.currentHunk++;
    this.render();
    this.maybeTriggerAI();
  }

  private async saveAndAdvance(): Promise<void> {
    try {
      await this.persistFile(this.file());
    } catch {
      return;
    }
    const next = this.files.findIndex((f, i) => i !== this.currentFile && !this.fileResolved(f));
    if (next >= 0) {
      this.currentFile = next;
      this.currentHunk = 0;
    }
    this.render();
    this.maybeTriggerAI();
  }

  private async persistFile(f: FileState): Promise<void> {
    try {
      await this.ops.writeFile(f.path, applyResolutions(f.segments, f.resolutions));
      f.persisted = true;
    } catch (e) {
      new Notice(`Covault: couldn't save ${f.path} — ${(e as Error).message}`);
      throw e;
    }
  }

  private async finish(btn?: HTMLButtonElement): Promise<void> {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Sharing…";
    }
    try {
      for (const f of this.files) if (!f.persisted) await this.persistFile(f);
      await this.ops.finishMerge(
        this.files.map((f) => f.path),
        `merge: resolve conflicts in ${this.files.map((f) => f.path).join(", ")}`,
      );
      new Notice(`Covault: ${this.files.length} file(s) merged and shared.`);
      this.close();
      this.onResolved();
    } catch (e) {
      new Notice(`Covault: couldn't share the merge — ${(e as Error).message}`);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Merge & share";
      }
    }
  }

  private async abort(): Promise<void> {
    await this.ops.abortMerge();
    new Notice("Covault: merge discarded — your notes are back to your version.");
    this.close();
    this.onResolved();
  }
}

function resolutionLabel(kind: HunkResolution["kind"]): string {
  switch (kind) {
    case "local":
      return "kept yours";
    case "remote":
      return "kept teammate's";
    case "both":
      return "kept both";
    case "edit":
      return "edited";
    case "skip":
      return "skipped";
  }
}

function confidenceLabel(n: number): string {
  if (n <= 1) return "very low";
  if (n === 2) return "low";
  if (n === 3) return "medium";
  if (n === 4) return "high";
  return "very high";
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

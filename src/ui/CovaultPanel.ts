import { ItemView, Notice, setIcon, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import { FuzzySuggestModal, type TAbstractFile } from "obsidian";
import type CovaultPlugin from "../main";
import type { FileCommit, RepoRef } from "../git/GitEngine";
import { AddLibraryModal } from "./AddLibraryModal";
import { MainKbModal } from "./MainKbModal";
import { ConfirmModal } from "./ConfirmModal";
import { FileHistoryModal } from "./FileHistoryModal";

export const COVAULT_VIEW_TYPE = "covault-panel";

/**
 * Right-sidebar tool panel. Three clearly separated areas:
 *   1. My knowledge base — what you share to your personal repo
 *   2. Team libraries    — the shared repos pulled into this vault
 *   3. History           — recent changes to the note you're reading
 * The first two carry inline add/remove and live sync state; the history
 * section sits at the bottom behind a drag-to-resize divider (drag it
 * near-closed to collapse it to a header button).
 */
export class CovaultPanel extends ItemView {
  // History section state — kept on the instance so a re-render (which
  // rebuilds the whole panel on every sync tick) doesn't wipe the view.
  /** Ticks the age labels while something is syncing; null when idle. */
  private taskTimer: number | null = null;
  private ghSectionEl: HTMLElement | null = null;
  private ghTitleEl: HTMLElement | null = null;
  private ghListEl: HTMLElement | null = null;
  private ghFile: string | null = null;
  private ghCommits: FileCommit[] = [];
  private ghCtx: { ref: RepoRef; relPath: string } | null = null;
  private ghPanelHeight: number | null = null;
  private ghCollapsed = false;
  /** Discards history responses for a file the user already navigated away from. */
  private ghLoadSeq = 0;

  private static readonly GH_MIN_HEIGHT = 80;
  private static readonly GH_COLLAPSE_AT = 48;
  private static readonly GH_HEIGHT_KEY = "covault-history-height";
  private static readonly GH_COLLAPSED_KEY = "covault-history-collapsed";

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: CovaultPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return COVAULT_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Covault";
  }
  getIcon(): string {
    return "library";
  }

  onOpen(): Promise<void> {
    const savedHeight = Number(this.app.loadLocalStorage(CovaultPanel.GH_HEIGHT_KEY));
    if (Number.isFinite(savedHeight) && savedHeight >= CovaultPanel.GH_MIN_HEIGHT) {
      this.ghPanelHeight = savedHeight;
    }
    this.ghCollapsed = this.app.loadLocalStorage(CovaultPanel.GH_COLLAPSED_KEY) === "1";

    this.render();
    this.registerEvent(this.app.workspace.on("file-open", (file) => void this.ghLoad(file)));
    void this.ghLoad(this.app.workspace.getActiveFile());
    return Promise.resolve();
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("covault-panel");

    const scroll = root.createDiv("covault-panel-scroll");

    // ── Header ────────────────────────────────────────────────
    // No sync-everything button up here: the sections carry their own, and
    // a global sweep next to them mostly invited accidental full sweeps.
    const header = scroll.createDiv("covault-panel-header");
    header.createSpan({ cls: "covault-panel-title", text: "Covault" });

    this.renderActiveTasks(scroll);

    const conflicts = this.plugin.sync.pendingConflicts();
    if (conflicts.length > 0) {
      const warn = scroll.createDiv("covault-panel-conflict-banner");
      const icon = warn.createSpan();
      setIcon(icon, "alert-triangle");
      warn.createSpan({ text: `${conflicts.length} note(s) need your input` });
      const btn = warn.createEl("button", { text: "Resolve…", cls: "mod-cta" });
      btn.onclick = () => this.plugin.openConflictModal();
    }

    this.renderPersonalSection(scroll);
    this.renderLibrariesSection(scroll);
    this.renderAskButton(root);
    this.renderHistorySection(root);
  }

  /**
   * What is syncing right now. Hidden when nothing is, so it never costs
   * space; visible the moment something starts, because otherwise a long
   * round is indistinguishable from a stuck one.
   */
  private renderActiveTasks(root: HTMLElement): void {
    if (this.taskTimer !== null) {
      window.clearInterval(this.taskTimer);
      this.taskTimer = null;
    }
    const tasks = this.plugin.sync.activeTasks();
    if (tasks.length === 0) return;
    const ages: { el: HTMLElement; startedAt: number }[] = [];
    const box = root.createDiv("covault-panel-tasks");
    const head = box.createDiv("covault-panel-tasks-head");
    setIcon(head.createSpan({ cls: "covault-panel-tasks-icon" }), "refresh-cw");
    head.createSpan({
      text: this.plugin.sync.isSweeping()
        ? `Syncing everything · ${tasks.length} in progress`
        : `Syncing · ${tasks.length} in progress`,
    });
    for (const task of tasks) {
      const row = box.createDiv("covault-panel-task");
      row.createSpan({ cls: "covault-panel-task-name", text: task.label });
      const age = row.createSpan({ cls: "covault-panel-task-age", text: describeAge(Date.now() - task.startedAt) });
      ages.push({ el: age, startedAt: task.startedAt });
    }
    // The panel only re-renders when a round starts or ends, so without a
    // tick a long round would show the age it had when it began — exactly
    // the case this list exists to make visible. Only the labels change.
    this.taskTimer = window.setInterval(() => {
      for (const { el, startedAt } of ages) el.setText(describeAge(Date.now() - startedAt));
    }, 1000);
    this.registerInterval(this.taskTimer);
  }

  /**
   * Outside the scrolling area on purpose: with fifteen libraries the list
   * fills the panel, and a button that scrolls away is a button that isn't
   * there when it's wanted.
   */
  private renderAskButton(root: HTMLElement): void {
    const bar = root.createDiv("covault-panel-ask-bar");
    const ask = bar.createEl("button", {
      cls: "covault-panel-ask",
      attr: { "aria-label": "Ask your knowledge base" },
    });
    setIcon(ask.createSpan({ cls: "covault-panel-ask-icon" }), "message-circle-question");
    ask.createSpan({ text: "Ask your knowledge base" });
    ask.onclick = () => void this.plugin.activateAskView();
  }

  /**
   * The coloured dot every synced thing carries, with its state in the
   * tooltip. Shared so the personal repo reads the same as a library.
   */
  private addStateDot(row: HTMLElement, repoPath: string): void {
    const state = this.plugin.sync.state(repoPath);
    const dot = row.createSpan({ cls: `covault-panel-state ${state.phase}` });
    dot.setAttribute(
      "title",
      state.phase === "idle"
        ? state.lastSyncedAt
          ? `Up to date · ${new Date(state.lastSyncedAt).toLocaleTimeString()}`
          : "Waiting for first sync"
        : (state.detail ?? state.phase),
    );
  }

  // ── Section 3: history of the current note ─────────────────
  private renderHistorySection(root: HTMLElement): void {
    const resizer = root.createDiv("covault-gh-resizer");
    resizer.setAttribute("aria-label", "Drag to resize history");

    const section = root.createDiv("covault-gh-section");
    this.ghSectionEl = section;

    const head = section.createDiv("covault-gh-header");
    const icon = head.createSpan("covault-gh-icon");
    setIcon(icon, "history");
    this.ghTitleEl = head.createSpan({ cls: "covault-gh-title", text: "History" });
    const expand = head.createEl("button", {
      cls: "covault-gh-expand-btn",
      attr: { "aria-label": "Open full history" },
    });
    setIcon(expand, "maximize-2");
    expand.onclick = (e) => {
      e.stopPropagation(); // don't also toggle the collapsed header
      this.ghOpenModal();
    };
    const chevron = head.createSpan("covault-gh-chevron");
    setIcon(chevron, "chevron-up");
    head.onclick = () => {
      if (this.ghCollapsed) this.ghSetCollapsed(false);
    };

    this.ghInitResize(resizer);
    this.ghListEl = section.createDiv("covault-gh-list");
    this.ghApplyPanelState();

    // Restore what was already loaded (render() runs on every sync tick).
    if (this.ghFile) {
      const name = this.ghFile.split("/").pop() ?? this.ghFile;
      this.ghTitleEl.setText(name);
      this.ghTitleEl.setAttribute("title", this.ghFile);
    }
    if (this.ghCommits.length > 0) this.ghRenderList();
    else this.ghEmpty(this.ghFile ? "No history for this note yet." : "Open a note to see its history.");
  }

  private ghEmpty(text: string): void {
    this.ghListEl?.empty();
    this.ghListEl?.createDiv({ cls: "covault-gh-empty", text });
  }

  /** Load the commit list for the newly opened file. */
  private async ghLoad(file: TFile | null): Promise<void> {
    if (!file) return;
    if (file.path === this.ghFile && this.ghCommits.length > 0) return;
    const seq = ++this.ghLoadSeq;

    this.ghFile = file.path;
    this.ghCommits = [];
    this.ghCtx = this.plugin.historyContextFor(file.path);
    if (this.ghTitleEl) {
      this.ghTitleEl.setText(file.name);
      this.ghTitleEl.setAttribute("title", file.path);
    }

    if (!this.ghCtx) {
      this.ghEmpty("This note isn't synced — share it to track its history.");
      return;
    }
    this.ghEmpty("Loading…");
    try {
      const commits = await this.plugin.engine.fileLog(this.ghCtx.ref, this.ghCtx.relPath, 30);
      if (seq !== this.ghLoadSeq) return; // superseded by a newer file
      this.ghCommits = commits;
      if (commits.length === 0) this.ghEmpty("No history for this note yet.");
      else this.ghRenderList();
    } catch (e) {
      if (seq !== this.ghLoadSeq) return;
      console.warn("[covault] couldn't load history:", e);
      this.ghEmpty("Couldn't load history.");
    }
  }

  private ghRenderList(): void {
    const list = this.ghListEl;
    if (!list) return;
    list.empty();
    const myEmail = this.plugin.gitAuthorEmail();
    for (const commit of this.ghCommits) {
      const row = list.createDiv("covault-gh-row");
      const isMine = commit.authorEmail === myEmail;
      const origin = row.createSpan({ cls: `covault-gh-origin-icon ${isMine ? "is-local" : "is-remote"}` });
      origin.setAttribute("aria-label", isMine ? "Your change" : `${commit.authorName}'s change`);
      setIcon(origin, isMine ? "upload" : "download");
      const msg = row.createSpan({ cls: "covault-gh-message", text: commit.message });
      msg.setAttribute("title", `${commit.message}\n${commit.authorName} · ${commit.hash.slice(0, 7)}`);
      row.createSpan({ cls: "covault-gh-date", text: ghRelativeDate(commit.date) });
      row.onclick = () => this.ghOpenModal();
    }
  }

  private ghOpenModal(): void {
    if (!this.ghCtx || !this.ghFile) {
      new Notice("Covault: open a synced note to see its history.");
      return;
    }
    new FileHistoryModal(
      this.app,
      this.plugin.engine,
      this.ghCtx.ref,
      this.ghCtx.relPath,
      this.ghFile,
      this.plugin.gitAuthorEmail(),
    ).open();
  }

  // ── History section sizing ─────────────────────────────────

  private ghApplyPanelState(): void {
    const section = this.ghSectionEl;
    if (!section) return;
    section.toggleClass("is-collapsed", this.ghCollapsed);
    // An explicit height only applies while expanded with a stored size;
    // otherwise the stylesheet's default sizing takes over.
    const sized = !this.ghCollapsed && this.ghPanelHeight !== null;
    section.toggleClass("is-sized", sized);
    if (sized) section.setCssProps({ "--covault-history-height": `${this.ghPanelHeight ?? 0}px` });
  }

  private ghSetCollapsed(collapsed: boolean): void {
    this.ghCollapsed = collapsed;
    this.ghApplyPanelState();
    this.app.saveLocalStorage(CovaultPanel.GH_COLLAPSED_KEY, collapsed ? "1" : null);
  }

  private ghInitResize(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      const section = this.ghSectionEl;
      if (!section) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.addClass("is-dragging");

      const startY = e.clientY;
      const startH = this.ghCollapsed ? 0 : section.getBoundingClientRect().height;
      // Always leave a sliver of the sections above visible.
      const panelH = this.contentEl.getBoundingClientRect().height;
      const maxH = Math.max(CovaultPanel.GH_MIN_HEIGHT, panelH - 120);

      const onMove = (ev: PointerEvent) => {
        const raw = startH + (startY - ev.clientY);
        if (raw < CovaultPanel.GH_COLLAPSE_AT) {
          if (!this.ghCollapsed) {
            this.ghCollapsed = true;
            this.ghApplyPanelState();
          }
          return;
        }
        this.ghCollapsed = false;
        this.ghPanelHeight = Math.min(Math.max(raw, CovaultPanel.GH_MIN_HEIGHT), maxH);
        this.ghApplyPanelState();
      };
      const onUp = (ev: PointerEvent) => {
        handle.removeClass("is-dragging");
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        this.app.saveLocalStorage(CovaultPanel.GH_COLLAPSED_KEY, this.ghCollapsed ? "1" : null);
        if (this.ghPanelHeight !== null) {
          this.app.saveLocalStorage(CovaultPanel.GH_HEIGHT_KEY, String(this.ghPanelHeight));
        }
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });
  }

  // ── Section 1: my knowledge base ───────────────────────────
  private renderPersonalSection(root: HTMLElement): void {
    const section = root.createDiv("covault-panel-section");
    const head = section.createDiv("covault-panel-section-head");
    // Same dot as a library: this repo syncs like any other, so it should
    // report like any other.
    if (this.plugin.settings.mainRepo) this.addStateDot(head, "");
    head.createSpan({ cls: "covault-panel-section-title", text: "My knowledge base" });
    const addBtn = head.createEl("button", { cls: "covault-panel-icon-btn", attr: { "aria-label": "Share a note or folder" } });
    setIcon(addBtn, "plus");

    const s = this.plugin.settings;
    if (!s.mainRepo) {
      addBtn.disabled = true;
      const empty = section.createDiv("covault-panel-empty");
      empty.createSpan({ text: "Not set up yet. " });
      const link = empty.createEl("a", { text: "Connect a personal repo" });
      link.onclick = () => new MainKbModal(this.app, this.plugin).open();
      return;
    }

    // Whole-vault scope: nothing to pick — everything outside the team
    // libraries is backed up already.
    if (this.plugin.mainKbScope() === "vault") {
      addBtn.disabled = true;
      addBtn.setAttribute("aria-label", "Everything is backed up already");
      // Nothing to pick, so nothing else would offer a way to sync just
      // this repo — the row is the only place for it.
      this.addSyncButton(head, "", "Sync my knowledge base now");
      const libs = this.plugin.libraryManifest.load().repos.length;
      section.createDiv({
        cls: "covault-panel-empty",
        text:
          libs === 0
            ? "Everything in this vault is backed up."
            : "Everything in this vault is backed up, except the team libraries below.",
      });
      return;
    }

    addBtn.onclick = () => new SharePickerModal(this.app, this.plugin, () => this.render()).open();

    const shared = this.plugin.libraryManifest.load().include;
    if (shared.length === 0) {
      section.createDiv({
        cls: "covault-panel-empty",
        text: "Nothing shared yet — everything stays private until you add it here.",
      });
      return;
    }

    const list = section.createDiv("covault-panel-list");
    for (const p of shared) {
      const row = list.createDiv("covault-panel-row");
      const icon = row.createSpan({ cls: "covault-panel-row-icon" });
      setIcon(icon, this.app.vault.getAbstractFileByPath(p) instanceof TFolder ? "folder" : "file-text");
      const name = row.createSpan({ cls: "covault-panel-row-name", text: p });
      name.setAttribute("title", p);
      const remove = row.createEl("button", { cls: "covault-panel-icon-btn", attr: { "aria-label": "Stop sharing" } });
      setIcon(remove, "x");
      remove.onclick = () => {
        this.plugin.unmarkSharedToMainKb(p);
        this.render();
      };
    }
  }

  // ── Section 2: team libraries ──────────────────────────────
  /** Sync just this repo. Disabled only while *this* repo is syncing;
   *  another library's sync is no reason to refuse. */
  private addSyncButton(row: HTMLElement, repoPath: string, label: string): void {
    const btn = row.createEl("button", { cls: "covault-panel-icon-btn", attr: { "aria-label": label } });
    setIcon(btn, "refresh-cw");
    if (this.plugin.sync.isSyncing(repoPath)) {
      btn.addClass("is-syncing");
      btn.disabled = true;
    }
    btn.onclick = async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      try {
        await this.plugin.sync.syncJust(repoPath);
      } finally {
        this.render();
      }
    };
  }

  private renderLibrariesSection(root: HTMLElement): void {
    const section = root.createDiv("covault-panel-section");
    const head = section.createDiv("covault-panel-section-head");
    head.createSpan({ cls: "covault-panel-section-title", text: "Team libraries" });
    const addBtn = head.createEl("button", { cls: "covault-panel-icon-btn", attr: { "aria-label": "Add a library" } });
    setIcon(addBtn, "plus");
    addBtn.onclick = () => new AddLibraryModal(this.app, this.plugin).open();

    const repos = this.plugin.libraryManifest.load().repos;
    if (repos.length === 0) {
      section.createDiv({
        cls: "covault-panel-empty",
        text: "No libraries yet — add one to pull your team's knowledge in.",
      });
      return;
    }

    const list = section.createDiv("covault-panel-list");
    for (const repo of repos) {
      const state = this.plugin.sync.state(repo.path);
      const row = list.createDiv("covault-panel-row");
      this.addStateDot(row, repo.path);

      const name = row.createSpan({ cls: "covault-panel-row-name", text: repo.path });
      name.setAttribute("title", `${repo.url} (${repo.branch})`);

      this.addSyncButton(row, repo.path, `Sync ${repo.path} now`);

      if (state.phase === "conflict") {
        const fix = row.createEl("button", { cls: "covault-panel-icon-btn conflict", attr: { "aria-label": "Resolve conflicts" } });
        setIcon(fix, "wrench");
        fix.onclick = () => this.plugin.openConflictModal();
      }

      const remove = row.createEl("button", { cls: "covault-panel-icon-btn", attr: { "aria-label": "Remove library" } });
      setIcon(remove, "x");
      remove.onclick = async () => {
        const answer = await ConfirmModal.askWithOption(this.app, {
          title: "Remove library",
          message: `Stop syncing "${repo.path}"? By default the folder and its notes stay on disk.`,
          cta: "Remove",
          option: {
            label: "Delete the local folder too",
            desc: `Removes "${repo.path}" and everything in it from this vault. Your team's copy on GitHub is untouched.`,
          },
        });
        if (!answer.ok) return;
        // Removing can wait on a sync round already in flight — the button
        // must not accept a second click meanwhile, and the user should
        // know why nothing seems to happen.
        remove.disabled = true;
        if (this.plugin.sync.isSyncing(repo.path)) {
          new Notice(`Covault: finishing the sync of "${repo.path}" first…`);
        }
        try {
          const result = await this.plugin.removeLibrary(repo.path, { deleteFiles: answer.option });
          new Notice(
            answer.option
              ? result.deletedFolder
                ? `Covault: "${repo.path}" is no longer synced, and its local folder is gone.`
                : `Covault: "${repo.path}" is no longer synced — but its folder was kept: it holds changes that never reached GitHub.`
              : `Covault: "${repo.path}" is no longer synced.`,
            answer.option && !result.deletedFolder ? 10_000 : undefined,
          );
        } catch (e) {
          new Notice(`Covault: couldn't remove "${repo.path}" — ${(e as Error).message}`);
        } finally {
          this.render();
        }
      };
    }
  }
}

/** Compact relative age for the panel's commit rows ("3h", "2d", "5mo"). */
function ghRelativeDate(date: Date): string {
  const mins = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  const mos = Math.floor(days / 30);
  if (mos < 12) return `${mos}mo`;
  return `${Math.floor(mos / 12)}y`;
}

/** Picker for "share a note or folder to my knowledge base". */
class SharePickerModal extends FuzzySuggestModal<TAbstractFile> {
  constructor(
    app: CovaultPanel["app"],
    private plugin: CovaultPlugin,
    private onDone: () => void,
  ) {
    super(app);
    this.setPlaceholder("Share which note or folder?");
  }

  getItems(): TAbstractFile[] {
    const libs = this.plugin.libraryManifest.load().repos;
    const insideLib = (p: string) => libs.some((r) => p === r.path || p.startsWith(`${r.path}/`));
    return this.app.vault
      .getAllLoadedFiles()
      .filter(
        (f) =>
          (f instanceof TFile || f instanceof TFolder) &&
          f.path !== "/" &&
          !insideLib(f.path) &&
          !this.plugin.isSharedToMainKb(f.path),
      );
  }

  getItemText(f: TAbstractFile): string {
    return f.path;
  }

  onChooseItem(f: TAbstractFile): void {
    this.plugin.markSharedToMainKb(f.path);
    new Notice(`Covault: "${f.path}" will be shared on the next sync (running now).`);
    this.onDone();
  }
}

/** "12s" / "3m" — enough to tell a slow round from a stuck one. */
function describeAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

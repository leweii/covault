import { ItemView, Notice, setIcon, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import { FuzzySuggestModal, type TAbstractFile } from "obsidian";
import type CovaultPlugin from "../main";
import type { RepoRef } from "../git/GitEngine";
import { AddLibraryModal } from "./AddLibraryModal";
import { MainKbModal } from "./MainKbModal";
import { ConfirmModal } from "./ConfirmModal";
import { FileHistoryModal } from "./FileHistoryModal";

export const COVAULT_VIEW_TYPE = "covault-panel";

/**
 * Right-sidebar tool panel. Two areas, both with inline add/remove and
 * live sync state:
 *   1. My knowledge base — what you share to your personal repo
 *   2. Team libraries    — the shared repos pulled into this vault
 * The history of the open note is one icon in the header corner: it used
 * to be a resizable list pinned to the bottom, which cost a third of the
 * panel to duplicate what FileHistoryModal already shows better.
 */
export class CovaultPanel extends ItemView {
  // The note whose history the header button would open. Kept on the
  // instance because a re-render (every sync tick) rebuilds the panel.
  private ghFile: string | null = null;
  private ghCtx: { ref: RepoRef; relPath: string } | null = null;
  private ghBtnEl: HTMLElement | null = null;

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
    this.render();
    this.registerEvent(this.app.workspace.on("file-open", (file) => this.ghTrack(file)));
    this.ghTrack(this.app.workspace.getActiveFile());
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
    this.ghBtnEl = header.createEl("button", { cls: "covault-panel-icon-btn" });
    setIcon(this.ghBtnEl, "history");
    this.ghBtnEl.onclick = () => this.ghOpenModal();
    this.ghApplyBtnState();

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
  }

  /**
   * Outside the scrolling area on purpose: with fifteen libraries the list
   * fills the panel, and a button that scrolls away is a button that isn't
   * there when it's wanted.
   */
  private renderAskButton(root: HTMLElement): void {
    const bar = root.createDiv("covault-panel-ask-bar");
    // mod-cta, not a hand-painted accent: themes style Obsidian's own CTA
    // class deliberately, and a private background is what left this
    // reading as an inert grey slab under Blue Topaz.
    const ask = bar.createEl("button", {
      cls: "covault-panel-ask mod-cta",
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
  /**
   * Remember which note the header button would show history for. No
   * commits are fetched here any more — the modal loads its own, so
   * opening a note no longer costs a git log it may never look at.
   */
  private ghTrack(file: TFile | null): void {
    if (!file) return;
    this.ghFile = file.path;
    this.ghCtx = this.plugin.historyContextFor(file.path);
    this.ghApplyBtnState();
  }

  /** The button says what it will do before it is pressed: which note,
   *  or dimmed when the open one isn't synced. */
  private ghApplyBtnState(): void {
    const btn = this.ghBtnEl;
    if (!btn) return;
    const name = this.ghFile?.split("/").pop();
    const available = this.ghCtx !== null && this.ghFile !== null;
    btn.toggleClass("is-idle", !available);
    btn.setAttribute(
      "aria-label",
      available
        ? `History of ${name}`
        : name
          ? `${name} isn't synced — share it to track its history`
          : "Open a synced note to see its history",
    );
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
  /**
   * Sync everything, now. A sweep rather than a loop over the libraries:
   * syncAll already skips what is mid-flight and folds a second click
   * into the round that is running, which a hand-rolled loop would not.
   */
  private addSweepButton(head: HTMLElement): void {
    const btn = head.createEl("button", {
      cls: "covault-panel-icon-btn",
      attr: { "aria-label": "Sync everything now" },
    });
    setIcon(btn, "refresh-cw");
    if (this.plugin.sync.isSweeping()) {
      btn.addClass("is-syncing");
      btn.disabled = true;
    }
    btn.onclick = async (e) => {
      e.stopPropagation();
      // Spun and dead on the first click: a sweep of fifteen libraries
      // takes long enough that an unchanged button reads as ignored.
      btn.disabled = true;
      btn.addClass("is-syncing");
      try {
        await this.plugin.sync.syncAll("manual");
      } finally {
        this.render();
      }
    };
  }

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
    this.addSweepButton(head);

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


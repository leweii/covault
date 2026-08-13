import { ItemView, Notice, setIcon, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import { FuzzySuggestModal, type TAbstractFile } from "obsidian";
import type CovaultPlugin from "../main";
import { AddLibraryModal } from "./AddLibraryModal";
import { MainKbModal } from "./MainKbModal";
import { ConfirmModal } from "./ConfirmModal";

export const COVAULT_VIEW_TYPE = "covault-panel";

/**
 * Right-sidebar tool panel. Two clearly separated areas:
 *   1. My knowledge base — what you share to your personal repo
 *   2. Team libraries    — the shared repos pulled into this vault
 * Both with inline add/remove; library rows show live sync state.
 */
export class CovaultPanel extends ItemView {
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
    return Promise.resolve();
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("covault-panel");

    // ── Header ────────────────────────────────────────────────
    const header = root.createDiv("covault-panel-header");
    header.createSpan({ cls: "covault-panel-title", text: "Covault" });
    const syncBtn = header.createEl("button", {
      cls: "covault-panel-icon-btn",
      attr: { "aria-label": "Sync now" },
    });
    setIcon(syncBtn, "refresh-cw");
    syncBtn.onclick = () => void this.plugin.sync.syncAll("manual");

    const conflicts = this.plugin.sync.pendingConflicts();
    if (conflicts.length > 0) {
      const warn = root.createDiv("covault-panel-conflict-banner");
      const icon = warn.createSpan();
      setIcon(icon, "alert-triangle");
      warn.createSpan({ text: `${conflicts.length} note(s) need your input` });
      const btn = warn.createEl("button", { text: "Resolve…", cls: "mod-cta" });
      btn.onclick = () => this.plugin.openConflictModal();
    }

    this.renderPersonalSection(root);
    this.renderLibrariesSection(root);
  }

  // ── Section 1: my knowledge base ───────────────────────────
  private renderPersonalSection(root: HTMLElement): void {
    const section = root.createDiv("covault-panel-section");
    const head = section.createDiv("covault-panel-section-head");
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

      const dot = row.createSpan({ cls: `covault-panel-state ${state.phase}` });
      dot.setAttribute(
        "title",
        state.phase === "idle"
          ? state.lastSyncedAt
            ? `Up to date · ${new Date(state.lastSyncedAt).toLocaleTimeString()}`
            : "Waiting for first sync"
          : (state.detail ?? state.phase),
      );

      const name = row.createSpan({ cls: "covault-panel-row-name", text: repo.path });
      name.setAttribute("title", `${repo.url} (${repo.branch})`);

      if (state.phase === "conflict") {
        const fix = row.createEl("button", { cls: "covault-panel-icon-btn conflict", attr: { "aria-label": "Resolve conflicts" } });
        setIcon(fix, "wrench");
        fix.onclick = () => this.plugin.openConflictModal();
      }

      const remove = row.createEl("button", { cls: "covault-panel-icon-btn", attr: { "aria-label": "Remove library" } });
      setIcon(remove, "x");
      remove.onclick = async () => {
        const ok = await ConfirmModal.ask(this.app, {
          title: "Remove library",
          message: `Stop syncing "${repo.path}"? The folder and its notes stay on disk.`,
          cta: "Remove",
        });
        if (!ok) return;
        this.plugin.libraryManifest.remove(repo.path);
        this.plugin.sharedRepos();
        new Notice(`Covault: "${repo.path}" is no longer synced.`);
        this.render();
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

/**
 * The document tree: every synced library (and the personal knowledge
 * base) as a folder tree, each file with its sync mark and its document
 * status, each folder with badges for what's inside. Two filter rows —
 * sync status and document status — plus a search box narrow it; while
 * anything is filtered every match is shown expanded, so "Collapse" only
 * means something unfiltered.
 *
 * The chrome (header, search box) is built once so typing never loses
 * focus to a sync tick; the chips and the list re-render from live data.
 */
import { Menu, Notice, TFile, setIcon } from "obsidian";
import type { DocStatusDef } from "../../settings";
import type { SyncItem } from "../../sync/SyncController";
import { isLfsPath } from "../../git/lfs";
import { AddLibraryModal } from "../../ui/AddLibraryModal";
import { ConfirmModal } from "../../ui/ConfirmModal";
import { FileHistoryModal } from "../../ui/FileHistoryModal";
import { MainKbModal } from "../../ui/MainKbModal";
import { SharePickerModal } from "../../ui/SharePickerModal";
import { readDocStatus } from "../docStatus";
import {
  buildTree,
  matchesSyncFilter,
  pruneTree,
  repoOutcome,
  STATUS_TEXT,
  type FileEntry,
  type StatusCounts,
  type SyncFilter,
  type TreeNode,
} from "../model";
import { rootKey, type WorkbenchContext } from "./context";
import { button, stateDot } from "./util";

export class DocTree {
  private chipsEl!: HTMLElement;
  private statusChipsEl!: HTMLElement;
  private listEl!: HTMLElement;
  private collapseBtn!: HTMLButtonElement;
  private searchEl!: HTMLInputElement;

  constructor(private ctx: () => WorkbenchContext) {}

  mount(el: HTMLElement): void {
    const ctx = this.ctx();
    const head = el.createDiv("covault-wb-col-head");
    head.createEl("h2", { text: "Team documents" });
    button(head, {
      icon: "folder-plus",
      cls: "covault-wb-icon-btn",
      title: "Add a library",
      onClick: () => new AddLibraryModal(ctx.app, ctx.plugin).open(),
    });
    this.collapseBtn = button(head, {
      text: "Collapse",
      cls: "covault-wb-btn-sm",
      onClick: () => {
        ctx.state.openDirs.clear();
        ctx.persistTree();
        this.render();
      },
    });

    const search = el.createDiv("covault-wb-search");
    setIcon(search.createSpan("covault-wb-search-icon"), "search");
    this.searchEl = search.createEl("input", { attr: { type: "text", placeholder: "Filter notes…", spellcheck: "false" } });
    this.searchEl.value = ctx.state.query;
    this.searchEl.oninput = () => {
      ctx.state.query = this.searchEl.value.trim().toLowerCase();
      this.render();
    };

    this.chipsEl = el.createDiv("covault-wb-chips");
    this.statusChipsEl = el.createDiv("covault-wb-chips");
    this.listEl = el.createDiv("covault-wb-treelist");

    const legend = el.createDiv("covault-wb-legend");
    for (const key of ["synced", "local", "incoming", "conflict"] as const) {
      const item = legend.createSpan();
      item.createSpan({ cls: `covault-wb-mark is-${key}`, text: STATUS_TEXT[key].mark });
      item.appendText(STATUS_TEXT[key].label);
    }
  }

  // ── Rendering ──────────────────────────────────────────────

  render(): void {
    const ctx = this.ctx();
    const filtering = ctx.state.filter !== "all" || ctx.state.statusFilter !== "all" || ctx.state.query !== "";
    this.collapseBtn.disabled = filtering;
    this.collapseBtn.setAttribute(
      "aria-label",
      filtering ? "Filtered views show every match expanded — clear the filters to collapse" : "Collapse all folders",
    );
    this.renderChips();
    this.renderList(filtering);
  }

  private docStatusOf(path: string) {
    const ctx = this.ctx();
    if (!path.toLowerCase().endsWith(".md")) return null;
    const file = ctx.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    return readDocStatus(ctx.app.metadataCache.getFileCache(file)?.frontmatter, ctx.plugin.settings.docStatuses);
  }

  private renderChips(): void {
    const ctx = this.ctx();
    const { state, index } = ctx;
    const counts = index.counts();
    this.chipsEl.empty();
    const chip = (parent: HTMLElement, on: boolean, label: string, n: number | null, onClick: () => void) => {
      const b = parent.createEl("button", { cls: `covault-wb-chip ${on ? "is-on" : ""}` });
      b.createSpan({ text: label });
      if (n !== null) b.createSpan({ cls: "covault-wb-chip-n", text: String(n) });
      b.onclick = onClick;
    };
    const syncChips: [SyncFilter, string, number | null][] = [
      ["all", "All", null],
      ["conflict", "Need input", counts.conflict],
      ["local", "Not shared", counts.local],
      ["incoming", "New", counts.incoming],
    ];
    for (const [key, label, n] of syncChips) chip(this.chipsEl, state.filter === key, label, n, () => ctx.setFilter(key));

    this.statusChipsEl.empty();
    this.statusChipsEl.createSpan({ cls: "covault-wb-chips-label", text: "Status" });
    const byDef = new Map<string, number>();
    for (const e of index.all()) {
      const id = this.docStatusOf(e.path)?.def?.id;
      if (id) byDef.set(id, (byDef.get(id) ?? 0) + 1);
    }
    chip(this.statusChipsEl, state.statusFilter === "all", "Any", null, () => {
      state.statusFilter = "all";
      this.render();
    });
    for (const def of ctx.plugin.settings.docStatuses) {
      chip(this.statusChipsEl, state.statusFilter === def.id, def.label, byDef.get(def.id) ?? 0, () => {
        state.statusFilter = state.statusFilter === def.id ? "all" : def.id;
        this.render();
      });
    }
  }

  private renderList(filtering: boolean): void {
    const ctx = this.ctx();
    const { plugin, index, state } = ctx;
    this.listEl.empty();
    const items = plugin.syncItems();
    // Libraries first, the personal knowledge base last.
    const ordered = [...items.filter((i) => i.path !== ""), ...items.filter((i) => i.path === "")];
    const keep = (e: FileEntry) =>
      matchesSyncFilter(e.status, state.filter) &&
      (state.statusFilter === "all" || this.docStatusOf(e.path)?.def?.id === state.statusFilter) &&
      (state.query === "" || e.rel.toLowerCase().includes(state.query));

    let shown = 0;
    for (const item of ordered) {
      const label = item.path === "" ? "My knowledge base" : (item.label ?? item.path);
      const full = buildTree(item.path, label, index.entriesFor(item.path));
      const tree = filtering ? pruneTree(full, keep) : full;
      if (!tree) continue;
      shown++;
      this.renderRoot(item, label, tree, filtering);
    }
    if (shown === 0) {
      this.listEl.createDiv({
        cls: "covault-wb-empty",
        text: filtering ? "Nothing matches these filters." : "No libraries yet — add one with the + above.",
      });
    }
  }

  private renderRoot(item: SyncItem, label: string, tree: TreeNode, filtering: boolean): void {
    const ctx = this.ctx();
    const { plugin, state } = ctx;
    const key = rootKey(item.path);
    const open = filtering || state.openDirs.has(key);
    const row = this.listEl.createDiv({ cls: "covault-wb-node is-root", attr: { "data-root": key } });
    setIcon(row.createSpan("covault-wb-tw"), open ? "chevron-down" : "chevron-right");
    const s = plugin.sync.state(item.path);
    stateDot(row, plugin.sync.isSyncing(item.path) ? "syncing" : repoOutcome(s));
    row.createSpan({ cls: "covault-wb-node-name", text: label, attr: { title: `${item.url} (${item.branch})` } });
    this.badges(row, tree.counts);
    const files = ctx.index.entriesFor(item.path).filter((e) => !e.ghost).length;
    if (ctx.index.has(item.path)) row.createSpan({ cls: "covault-wb-node-meta", text: String(files) });
    if (item.path === "" && plugin.settings.mainRepo && plugin.mainKbScope() === "marked") {
      button(row, {
        icon: "plus",
        cls: "covault-wb-icon-btn covault-wb-node-btn",
        title: "Share a note or folder",
        onClick: () => new SharePickerModal(ctx.app, plugin, () => ctx.refresh("index")).open(),
      });
    }
    row.onclick = () => {
      if (filtering) return;
      if (state.openDirs.has(key)) state.openDirs.delete(key);
      else state.openDirs.add(key);
      ctx.persistTree();
      this.render();
    };
    row.oncontextmenu = (e) => this.rootMenu(item, label).showAtMouseEvent(e);
    if (!open) return;
    for (const child of tree.children) this.renderNode(child, 1, filtering);
  }

  private renderNode(node: TreeNode, depth: number, filtering: boolean): void {
    const ctx = this.ctx();
    const { state } = ctx;
    const pad = `${6 + depth * 14}px`;
    if (node.kind === "dir") {
      const open = filtering || state.openDirs.has(node.path);
      const row = this.listEl.createDiv({ cls: "covault-wb-node", attr: { "data-dir": node.path } });
      row.style.paddingLeft = pad;
      setIcon(row.createSpan("covault-wb-tw"), open ? "chevron-down" : "chevron-right");
      setIcon(row.createSpan("covault-wb-node-icon"), "folder");
      row.createSpan({ cls: "covault-wb-node-name", text: node.name });
      this.badges(row, node.counts);
      row.onclick = () => {
        if (filtering) return;
        if (state.openDirs.has(node.path)) state.openDirs.delete(node.path);
        else state.openDirs.add(node.path);
        ctx.persistTree();
        this.render();
      };
      if (open) for (const child of node.children) this.renderNode(child, depth + 1, filtering);
      return;
    }
    const entry = node.entry!;
    const row = this.listEl.createDiv({
      cls: `covault-wb-node is-file ${state.selectedPath === entry.path ? "is-sel" : ""} ${entry.ghost ? "is-ghost" : ""}`,
      attr: { "data-file": entry.path, title: STATUS_TEXT[entry.status].label + (entry.author ? ` · ${entry.author}` : "") },
    });
    row.style.paddingLeft = pad;
    row.createSpan("covault-wb-tw");
    row.createSpan({ cls: `covault-wb-mark is-${entry.status}`, text: STATUS_TEXT[entry.status].mark });
    setIcon(row.createSpan("covault-wb-node-icon"), isLfsPath(entry.rel) ? "paperclip" : "file");
    row.createSpan({ cls: "covault-wb-node-name", text: node.name });
    const ds = this.docStatusOf(entry.path);
    if (ds) this.docTag(row, ds.def, ds.raw);
    row.onclick = () => ctx.showFile(entry.path);
    row.ondblclick = () => this.openNote(entry.path);
    row.oncontextmenu = (e) => this.fileMenu(entry).showAtMouseEvent(e);
  }

  private badges(parent: HTMLElement, counts: StatusCounts): void {
    const badge = (n: number, cls: string, title: string) => {
      if (n) parent.createSpan({ cls: `covault-wb-badge is-${cls}`, text: String(n), attr: { "aria-label": title } });
    };
    badge(counts.conflict, "conflict", "Need your input");
    badge(counts.local, "local", "Not shared yet");
    badge(counts.incoming, "incoming", "New from teammates");
  }

  private docTag(parent: HTMLElement, def: DocStatusDef | null, raw: string): void {
    const tag = parent.createSpan({ cls: `covault-wb-dtag ${def ? "" : "is-unknown"}`, text: def?.label ?? raw });
    if (def) tag.style.setProperty("--c", def.color);
    tag.setAttribute("aria-label", def ? `Document status: ${def.label}` : `Status "${raw}" isn't in the team's list`);
  }

  // ── Reveal ─────────────────────────────────────────────────

  /** Expand everything above a path (a file or a repo root) and scroll to it. */
  reveal(target: string, repoPath: string): void {
    const ctx = this.ctx();
    ctx.state.openDirs.add(rootKey(repoPath));
    if (target !== repoPath) {
      const parts = target.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (dir.length > repoPath.length) ctx.state.openDirs.add(dir);
      }
    }
    ctx.persistTree();
    this.render();
    const row =
      target === repoPath
        ? this.listEl.querySelector<HTMLElement>(`[data-root="${CSS.escape(rootKey(repoPath))}"]`)
        : this.listEl.querySelector<HTMLElement>(`[data-file="${CSS.escape(target)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }

  // ── Menus ──────────────────────────────────────────────────

  private openNote(path: string): void {
    const ctx = this.ctx();
    const file = ctx.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) void ctx.app.workspace.getLeaf(false).openFile(file);
    else new Notice(`Covault: ${path} isn't in the vault any more.`);
  }

  private fileMenu(entry: FileEntry): Menu {
    const ctx = this.ctx();
    const { plugin, app } = ctx;
    const menu = new Menu();
    if (!entry.ghost) menu.addItem((i) => i.setTitle("Open note").setIcon("file").onClick(() => this.openNote(entry.path)));
    menu.addItem((i) =>
      i
        .setTitle("History")
        .setIcon("history")
        .onClick(() => {
          const h = plugin.historyContextFor(entry.path);
          if (h) new FileHistoryModal(app, plugin.engine, h.ref, h.relPath, entry.path, plugin.gitAuthorEmail()).open();
        }),
    );
    menu.addItem((i) =>
      i
        .setTitle("Copy path")
        .setIcon("copy")
        .onClick(() => void navigator.clipboard.writeText(entry.path)),
    );
    if (entry.repoPath === "" && plugin.mainKbScope() === "marked") {
      menu.addSeparator();
      const shared = plugin.isSharedToMainKb(entry.path);
      menu.addItem((i) =>
        i
          .setTitle(shared ? "Stop sharing" : "Share to my knowledge base")
          .setIcon(shared ? "x" : "share-2")
          .onClick(() => {
            if (shared) plugin.unmarkSharedToMainKb(entry.path);
            else plugin.markSharedToMainKb(entry.path);
            ctx.refresh("index");
          }),
      );
    }
    return menu;
  }

  private rootMenu(item: SyncItem, label: string): Menu {
    const ctx = this.ctx();
    const { plugin, app } = ctx;
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle(`Sync ${label} now`)
        .setIcon("refresh-cw")
        .onClick(() => void plugin.sync.syncJust(item.path).then(() => ctx.refresh("state"))),
    );
    if (item.path === "") {
      if (plugin.mainKbScope() === "marked") {
        menu.addItem((i) =>
          i
            .setTitle("Share a note or folder…")
            .setIcon("plus")
            .onClick(() => new SharePickerModal(app, plugin, () => ctx.refresh("index")).open()),
        );
      }
      menu.addItem((i) => i.setTitle("Personal knowledge base settings…").setIcon("settings").onClick(() => new MainKbModal(app, plugin).open()));
      return menu;
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Remove library…")
        .setIcon("trash-2")
        .onClick(() => void this.removeLibrary(item.path)),
    );
    return menu;
  }

  private async removeLibrary(repoPath: string): Promise<void> {
    const ctx = this.ctx();
    const { plugin, app } = ctx;
    const answer = await ConfirmModal.askWithOption(app, {
      title: "Remove library",
      message: `Stop syncing "${repoPath}"? By default the folder and its notes stay on disk.`,
      cta: "Remove",
      option: {
        label: "Delete the local folder too",
        desc: `Removes "${repoPath}" and everything in it from this vault. Your team's copy on GitHub is untouched.`,
      },
    });
    if (!answer.ok) return;
    if (plugin.sync.isSyncing(repoPath)) new Notice(`Covault: finishing the sync of "${repoPath}" first…`);
    try {
      const result = await plugin.removeLibrary(repoPath, { deleteFiles: answer.option });
      new Notice(
        answer.option
          ? result.deletedFolder
            ? `Covault: "${repoPath}" is no longer synced, and its local folder is gone.`
            : `Covault: "${repoPath}" is no longer synced — but its folder was kept: it holds changes that never reached GitHub.`
          : `Covault: "${repoPath}" is no longer synced.`,
        answer.option && !result.deletedFolder ? 10_000 : undefined,
      );
    } catch (e) {
      new Notice(`Covault: couldn't remove "${repoPath}" — ${(e as Error).message}`);
    } finally {
      ctx.refresh("all");
    }
  }
}

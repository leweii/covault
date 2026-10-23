/**
 * The workbench: one full-page tab that answers "is my team knowledge in
 * sync, and what needs me?" — counters and the countdown to the next
 * sync up top; libraries, failed syncs, conflicts and the sync/jobs log
 * in the middle; the document tree and a note's details to the sides
 * (phase 2) and a note's history over it all (phase 3).
 *
 * Each section renders into its own element from live data, so a sync
 * tick re-renders what changed and nothing else; what the user has
 * expanded, selected or filtered lives on the view and survives every
 * re-render. "Syncing" is drawn as a loading state on top of a repo's
 * last known state — never as a blank where the state used to be.
 */
import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type CovaultPlugin from "../main";
import type { FileStatusIndex } from "./fileStatus";
import type { SyncFilter } from "./model";
import { applySavedWidth, installResizer, type ResizeSpec } from "./resizable";
import { rootKey, type LogTab, type RefreshScope, type WbState, type WorkbenchContext } from "./sections/context";
import { renderConflicts } from "./sections/Conflicts";
import { DocTree } from "./sections/DocTree";
import { renderFailures } from "./sections/Failures";
import { renderHeader, tickHeader } from "./sections/Header";
import { renderInspector } from "./sections/Inspector";
import { renderJobs, tickJobs } from "./sections/JobsTab";
import { renderLibraries } from "./sections/Libraries";
import { renderSyncLog } from "./sections/SyncLogTab";

export const COVAULT_WORKBENCH_VIEW_TYPE = "covault-workbench";

const TREE_W: ResizeSpec = { key: "covault-wb-tree-w", cssVar: "--covault-wb-tree-w", defaultPx: 330, minPx: 220, maxPx: 560, grows: "right" };
const INSP_W: ResizeSpec = { key: "covault-wb-insp-w", cssVar: "--covault-wb-insp-w", defaultPx: 320, minPx: 260, maxPx: 600, grows: "left" };

interface Sections {
  header: HTMLElement;
  tree: HTMLElement;
  libs: HTMLElement;
  failures: HTMLElement;
  conflicts: HTMLElement;
  tabs: HTMLElement;
  tabBody: HTMLElement;
  inspector: HTMLElement;
}

export class WorkbenchView extends ItemView {
  private readonly index: FileStatusIndex;
  private readonly state: WbState;
  private els: Sections | null = null;
  private tree = new DocTree(() => this.context());
  private unsubscribeIndex: (() => void) | null = null;
  private metadataTimer: number | null = null;
  /** The newest sync record seen — a newer one arriving opens itself. */
  private newestLogAt: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: CovaultPlugin,
  ) {
    super(leaf);
    this.index = plugin.fileStatus();
    const stored = (key: string) => plugin.app.loadLocalStorage(key) as unknown;
    const openDirs = stored("covault-wb-open-dirs");
    this.state = {
      tab: stored("covault-wb-tab") === "jobs" ? "jobs" : "sync",
      libsOpen: stored("covault-wb-libs-open") === true,
      filter: "all",
      statusFilter: "all",
      query: "",
      openDirs: new Set(Array.isArray(openDirs) ? openDirs.filter((k): k is string => typeof k === "string") : []),
      errOpen: new Set(),
      expandedLog: new Set(),
      expandedJobs: new Set(),
      expandedRuns: new Set(),
      selectedPath: null,
    };
  }

  getViewType(): string {
    return COVAULT_WORKBENCH_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Covault workbench";
  }
  getIcon(): string {
    return "library";
  }

  onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("covault-wb");
    applySavedWidth(this.app, root, TREE_W);
    applySavedWidth(this.app, root, INSP_W);

    const header = root.createDiv("covault-wb-header");
    const body = root.createDiv("covault-wb-body");

    const tree = body.createDiv("covault-wb-tree");
    installResizer(this.app, root, tree.createDiv(), TREE_W);
    this.tree.mount(tree);
    const main = body.createDiv("covault-wb-main");
    const libs = main.createDiv("covault-wb-libs");
    const failures = main.createDiv("covault-wb-failures");
    const conflicts = main.createDiv("covault-wb-conflicts");
    const logCard = main.createDiv("covault-wb-card covault-wb-logcard");
    const tabs = logCard.createDiv("covault-wb-tabs");
    const tabBody = logCard.createDiv("covault-wb-tabbody");
    const inspector = body.createDiv("covault-wb-insp");
    installResizer(this.app, root, inspector.createDiv(), INSP_W);
    this.els = { header, tree, libs, failures, conflicts, tabs, tabBody, inspector };

    this.unsubscribeIndex = this.index.onChange(() => this.refresh("index"));
    // Document statuses live in frontmatter: the cache catching up with an
    // edit (ours or the editor's) re-draws the tags, a little later.
    this.registerEvent(
      this.app.metadataCache.on("changed", () => {
        if (this.metadataTimer !== null) window.clearTimeout(this.metadataTimer);
        this.metadataTimer = window.setTimeout(() => {
          this.metadataTimer = null;
          this.refresh("tree");
        }, 300);
      }),
    );
    this.index.refreshAll();
    this.registerInterval(window.setInterval(() => this.tick(), 1_000));
    this.refresh("all");
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    this.unsubscribeIndex?.();
    this.unsubscribeIndex = null;
    this.els = null;
    return Promise.resolve();
  }

  // ── Rendering ──────────────────────────────────────────────

  refresh(scope: RefreshScope): void {
    const els = this.els;
    if (!els) return;
    const ctx = this.context();
    if (scope === "all" || scope === "state" || scope === "index" || scope === "jobs") renderHeader(ctx, els.header);
    if (scope === "all" || scope === "state" || scope === "index") {
      renderLibraries(ctx, els.libs);
      renderFailures(ctx, els.failures);
      renderConflicts(ctx, els.conflicts);
    }
    if (scope === "all" || scope === "state" || scope === "index" || scope === "tree") this.tree.render();
    if (scope === "all" || scope === "state" || scope === "index" || scope === "inspector") {
      renderInspector(ctx, els.inspector, this.state.selectedPath);
    }
    if (scope === "all" || scope === "state" || scope === "log" || scope === "jobs") {
      this.openNewestRecord();
      this.renderTabs(ctx, els.tabs);
      if (this.state.tab === "sync" && scope !== "jobs") renderSyncLog(ctx, els.tabBody);
      if (this.state.tab === "jobs") renderJobs(ctx, els.tabBody, this);
    }
  }

  /** Once a second: countdowns only. */
  private tick(): void {
    const els = this.els;
    if (!els) return;
    tickHeader(this.context(), els.header);
    if (this.state.tab === "jobs") tickJobs(els.tabBody);
  }

  private renderTabs(ctx: WorkbenchContext, el: HTMLElement): void {
    el.empty();
    const tab = (id: LogTab, label: string, count: number) => {
      const btn = el.createEl("button", { cls: `covault-wb-tab ${this.state.tab === id ? "is-on" : ""}` });
      btn.createSpan({ text: label });
      btn.createSpan({ cls: "covault-wb-tab-count", text: String(count) });
      btn.onclick = () => ctx.showTab(id);
    };
    tab("sync", "Sync log", this.plugin.syncHistory.records().length);
    tab("jobs", "Jobs", this.plugin.automations.list().length);
  }

  /** A newer round than the one last seen opens itself; older ones stay as the user left them. */
  private openNewestRecord(): void {
    const top = this.plugin.syncHistory.records(1)[0]?.at ?? null;
    if (top === null || top === this.newestLogAt) return;
    this.newestLogAt = top;
    this.state.expandedLog = new Set([top]);
  }

  // ── What the sections can ask of the view ──────────────────

  private context(): WorkbenchContext {
    return {
      app: this.app,
      plugin: this.plugin,
      index: this.index,
      state: this.state,
      refresh: (scope) => this.refresh(scope),
      showFile: (path) => this.showFile(path),
      closeInspector: () => this.select(null),
      revealInTree: (repoPath) => {
        this.tree.reveal(repoPath, repoPath);
        this.els?.tree.scrollIntoView({ behavior: "smooth", block: "nearest" });
      },
      persistTree: () => this.app.saveLocalStorage("covault-wb-open-dirs", [...this.state.openDirs]),
      scrollToFailures: () => this.els?.failures.scrollIntoView({ behavior: "smooth", block: "center" }),
      openClaudianFor: (item, error) => this.plugin.handToClaudian(item, error),
      showTab: (tab) => {
        this.state.tab = tab;
        this.app.saveLocalStorage("covault-wb-tab", tab);
        this.refresh("log");
      },
      setFilter: (filter: SyncFilter) => {
        this.state.filter = filter;
        this.refresh("tree");
      },
    };
  }

  /** Select a note: reveal it in the tree, open the inspector on it. */
  private showFile(vaultPath: string): void {
    const owner = this.plugin.repoItemForPath(vaultPath);
    if (!owner) {
      new Notice(`Covault: ${vaultPath} isn't in a synced library.`);
      return;
    }
    this.select(vaultPath);
    this.tree.reveal(vaultPath, owner.path);
  }

  /**
   * Change the selection. Leaving a note that was "new from teammates"
   * counts as having looked at it — the mark goes when the user moves on,
   * not the moment the inspector opens and shows it.
   */
  private select(vaultPath: string | null): void {
    const previous = this.state.selectedPath;
    this.state.selectedPath = vaultPath;
    if (previous && previous !== vaultPath) {
      const entry = this.index.all().find((e) => e.path === previous);
      if (entry?.status === "incoming") {
        this.plugin.sync.markFileSeen(entry.repoPath, entry.rel);
        this.index.markedSeen(entry.repoPath);
      }
    }
    this.refresh("inspector");
    this.refresh("tree");
    if (this.els) renderConflicts(this.context(), this.els.conflicts); // selection highlight
  }
}

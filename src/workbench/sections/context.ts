/**
 * What every workbench section is handed: the plugin, the status index,
 * the view's UI state (what is expanded, selected, filtered), and a few
 * callbacks into the view. Sections render into the element they are
 * given and ask the view to refresh; they never reach into each other.
 */
import type { App } from "obsidian";
import type CovaultPlugin from "../../main";
import type { SyncItem } from "../../sync/SyncController";
import type { FileStatusIndex } from "../fileStatus";
import type { SyncFilter } from "../model";

export type LogTab = "sync" | "jobs";

/** Expand/selection state. Lives on the view, so a re-render of any
 *  section (every sync tick) leaves it exactly as the user had it. */
export interface WbState {
  tab: LogTab;
  libsOpen: boolean;
  filter: SyncFilter;
  /** Document-status filter: "all" or a DocStatusDef id. */
  statusFilter: string;
  /** Tree search, lower-cased. */
  query: string;
  /** Open tree nodes: repo roots by their root key, folders by vault path. */
  openDirs: Set<string>;
  /** Repos whose failure alert shows the full error. */
  errOpen: Set<string>;
  /** Sync-log records (by `at`) shown with their file lists. */
  expandedLog: Set<number>;
  /** Sync-log page, 0-based; back to the first page when a new round lands. */
  logPage: number;
  expandedJobs: Set<string>;
  expandedRuns: Set<string>;
  selectedPath: string | null;
}

export type RefreshScope = "all" | "state" | "index" | "jobs" | "log" | "tree" | "inspector";

/** Tree key of a repo's root row ("" is the personal KB). */
export const rootKey = (repoPath: string): string => (repoPath === "" ? "~personal" : repoPath);

export interface WorkbenchContext {
  app: App;
  plugin: CovaultPlugin;
  index: FileStatusIndex;
  state: WbState;
  refresh: (scope: RefreshScope) => void;
  /** A file name was clicked anywhere: select it, reveal it in the tree, open the inspector. */
  showFile: (vaultPath: string) => void;
  closeInspector: () => void;
  /** Expand and scroll to a repo's root row. */
  revealInTree: (repoPath: string) => void;
  /** A note's whole history, over the workbench. */
  openTimeMachine: (vaultPath: string) => void;
  /** Open-folder state changed — remember it. */
  persistTree: () => void;
  /** Bring the failure alerts into view (from a failed log row or the KPI). */
  scrollToFailures: () => void;
  /** Hand a library's failed sync to Claudian. */
  openClaudianFor: (item: SyncItem, error: string) => Promise<void>;
  /** Switch the log card's tab. */
  showTab: (tab: LogTab) => void;
  setFilter: (filter: SyncFilter) => void;
}

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
  /** Repos whose failure alert shows the full error. */
  errOpen: Set<string>;
  /** Sync-log records (by `at`) shown with their file lists. */
  expandedLog: Set<number>;
  expandedJobs: Set<string>;
  expandedRuns: Set<string>;
  selectedPath: string | null;
}

export type RefreshScope = "all" | "state" | "index" | "jobs" | "log";

export interface WorkbenchContext {
  app: App;
  plugin: CovaultPlugin;
  index: FileStatusIndex;
  state: WbState;
  refresh: (scope: RefreshScope) => void;
  /** A file name was clicked anywhere: show it (the inspector, once it exists). */
  showFile: (vaultPath: string) => void;
  /** Bring the failure alerts into view (from a failed log row or the KPI). */
  scrollToFailures: () => void;
  /** Hand a library's failed sync to Claudian. */
  openClaudianFor: (item: SyncItem, error: string) => Promise<void>;
  /** Switch the log card's tab. */
  showTab: (tab: LogTab) => void;
  setFilter: (filter: SyncFilter) => void;
}

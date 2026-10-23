import { ItemView, type WorkspaceLeaf } from "obsidian";

export const RETIRED_PANEL_VIEW_TYPE = "covault-panel";

/**
 * The sidebar panel the workbench replaced. Still registered for one
 * release so a workspace saved with the panel open restores cleanly: an
 * unknown view type would sit there as a blank pane. This one closes
 * its own leaf as soon as it opens.
 */
export class RetiredPanelView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }
  getViewType(): string {
    return RETIRED_PANEL_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Covault";
  }
  getIcon(): string {
    return "library";
  }
  onOpen(): Promise<void> {
    // After the open completes, not during it.
    window.setTimeout(() => this.leaf.detach(), 0);
    return Promise.resolve();
  }
}

import { Modal, Notice, type App } from "obsidian";
import type { SyncHistory } from "../debug/syncHistory";

/** The recent sync history, newest at the bottom, with where the file lives. */
export class SyncHistoryModal extends Modal {
  constructor(
    app: App,
    private history: SyncHistory,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("covault-synchist-modal");
    this.titleEl.setText("Sync history");
    const path = this.history.filePath();
    const head = this.contentEl.createDiv("covault-synchist-head");
    head.createSpan({ cls: "covault-synchist-path", text: path });
    const copy = head.createEl("button", { text: "Copy path" });
    copy.onclick = () => {
      void navigator.clipboard.writeText(path);
      new Notice("Covault: path copied.");
    };

    const text = this.history.tail();
    const pre = this.contentEl.createEl("pre", {
      cls: "covault-synchist-body",
      text: text || "No successful syncs recorded yet.",
    });
    // Newest last, so start at the bottom.
    window.requestAnimationFrame(() => (pre.scrollTop = pre.scrollHeight));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

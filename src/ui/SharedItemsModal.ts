import { Modal, Setting, type App } from "obsidian";
import type CovaultPlugin from "../main";

/** Scrollable manager for everything marked "share to my knowledge base"
 *  — the settings page only shows a count, this holds the actual list. */
export class SharedItemsModal extends Modal {
  constructor(
    app: App,
    private plugin: CovaultPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Shared to your knowledge base");
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const shared = this.plugin.libraryManifest.load().include;
    if (shared.length === 0) {
      contentEl.createEl("p", {
        text: "Nothing shared yet. Right-click a note or folder and choose “Share to my knowledge base”.",
      });
      return;
    }

    contentEl.createEl("p", {
      text: `${shared.length} item(s) sync to your personal repo. Everything else stays local.`,
    });
    for (const p of shared) {
      new Setting(contentEl).setName(p).addButton((btn) =>
        btn.setButtonText("Stop sharing").onClick(() => {
          this.plugin.unmarkSharedToMainKb(p);
          this.render();
        }),
      );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

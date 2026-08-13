import { Modal, Setting, type App } from "obsidian";

/** Small yes/no dialog. Resolves false when dismissed without choosing. */
export class ConfirmModal extends Modal {
  private resolved = false;

  private constructor(
    app: App,
    private opts: { title: string; message: string; cta: string },
    private resolve: (ok: boolean) => void,
  ) {
    super(app);
  }

  static ask(app: App, opts: { title: string; message: string; cta: string }): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModal(app, opts, resolve).open());
  }

  onOpen(): void {
    this.titleEl.setText(this.opts.title);
    this.contentEl.createEl("p", { text: this.opts.message });
    new Setting(this.contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.resolved = true;
          this.resolve(false);
          this.close();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(this.opts.cta)
          .setCta()
          .onClick(() => {
            this.resolved = true;
            this.resolve(true);
            this.close();
          }),
      );
  }

  onClose(): void {
    if (!this.resolved) this.resolve(false);
    this.contentEl.empty();
  }
}

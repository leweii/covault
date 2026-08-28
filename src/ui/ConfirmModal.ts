import { Modal, Setting, type App } from "obsidian";

type ConfirmOpts = {
  title: string;
  message: string;
  cta: string;
  /** An extra choice the confirmation carries, e.g. "delete the files too".
   *  Off by default: the destructive half must be asked for. */
  option?: { label: string; desc?: string };
};

/** Small yes/no dialog. Resolves false when dismissed without choosing. */
export class ConfirmModal extends Modal {
  private resolved = false;
  private optionOn = false;

  private constructor(
    app: App,
    private opts: ConfirmOpts,
    private resolve: (answer: { ok: boolean; option: boolean }) => void,
  ) {
    super(app);
  }

  static ask(app: App, opts: ConfirmOpts): Promise<boolean> {
    return ConfirmModal.askWithOption(app, opts).then((a) => a.ok);
  }

  /** Same dialog, but the caller also needs the checkbox's answer. */
  static askWithOption(app: App, opts: ConfirmOpts): Promise<{ ok: boolean; option: boolean }> {
    return new Promise((resolve) => new ConfirmModal(app, opts, resolve).open());
  }

  onOpen(): void {
    this.titleEl.setText(this.opts.title);
    this.contentEl.createEl("p", { text: this.opts.message });
    if (this.opts.option) {
      const row = new Setting(this.contentEl).setName(this.opts.option.label);
      if (this.opts.option.desc) row.setDesc(this.opts.option.desc);
      row.addToggle((t) => t.setValue(false).onChange((v) => (this.optionOn = v)));
    }
    new Setting(this.contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.finish(false)),
      )
      .addButton((btn) =>
        btn
          .setButtonText(this.opts.cta)
          .setCta()
          .onClick(() => this.finish(true)),
      );
  }

  private finish(ok: boolean): void {
    this.resolved = true;
    this.resolve({ ok, option: ok && this.optionOn });
    this.close();
  }

  onClose(): void {
    if (!this.resolved) this.resolve({ ok: false, option: false });
    this.contentEl.empty();
  }
}

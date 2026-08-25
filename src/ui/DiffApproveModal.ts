import { Modal, type App } from "obsidian";

/**
 * "Here is exactly what will change — allow it?" A unified diff rendered
 * line by line (additions green, removals red), scrollable, with the
 * decision buttons pinned below. Used by Ask for note edits; unlike the
 * plain confirm, this is never remembered — every edit shows its diff.
 */
export class DiffApproveModal extends Modal {
  private resolve!: (allowed: boolean) => void;
  private decided = false;

  constructor(
    app: App,
    private action: string,
    private diff: string,
  ) {
    super(app);
  }

  static ask(app: App, action: string, diff: string): Promise<boolean> {
    const modal = new DiffApproveModal(app, action, diff);
    return new Promise((resolve) => {
      modal.resolve = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    this.modalEl.addClass("covault-diff-approve");
    this.titleEl.setText(this.action);
    const { contentEl } = this;

    const body = contentEl.createDiv("covault-diff-body");
    // Skip the patch preamble (---/+++ header lines carry no information
    // the title doesn't already show).
    const lines = this.diff.split("\n").filter((l, i) => !(i < 4 && (l.startsWith("---") || l.startsWith("+++") || l.startsWith("Index") || l.startsWith("="))));
    for (const line of lines) {
      const cls =
        line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "ctx";
      body.createDiv({ cls: `covault-diff-line ${cls}`, text: line || " " });
    }

    const actions = contentEl.createDiv("covault-diff-actions");
    const deny = actions.createEl("button", { text: "Don't allow" });
    deny.onclick = () => this.finish(false);
    const allow = actions.createEl("button", { text: "Apply this change", cls: "mod-cta" });
    allow.onclick = () => this.finish(true);
  }

  private finish(allowed: boolean): void {
    this.decided = true;
    this.resolve(allowed);
    this.close();
  }

  onClose(): void {
    if (!this.decided) this.resolve(false); // closed via Esc/backdrop = no
    this.contentEl.empty();
  }
}

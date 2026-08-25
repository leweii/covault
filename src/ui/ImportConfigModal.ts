/**
 * Paste → plan → confirm. The import never writes anything the user
 * didn't just read: planConfigImport computes exactly what would change
 * (and what is refused, with reasons), this modal shows it, and only a
 * confirmed plan reaches plugin.applyConfigImport.
 */
import { Modal, Notice, Setting, type App } from "obsidian";
import type CovaultPlugin from "../main";
import { parseConfigImport, planConfigImport, type ImportPlan } from "../covault/exportConfig";

export class ImportConfigModal extends Modal {
  private plan: ImportPlan | null = null;
  private busy = false;

  constructor(
    app: App,
    private plugin: CovaultPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("covault-import-modal");
    this.titleEl.setText("Import a configuration");
    this.renderPaste();
  }

  private renderPaste(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: "Paste a configuration another Covault exported. Nothing changes until you confirm the plan.",
    });
    const input = contentEl.createEl("textarea", {
      cls: "covault-import-input",
      attr: { rows: "10", placeholder: '{"covaultExport": …}' },
    });
    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Preview changes")
        .setCta()
        .onClick(() => {
          try {
            const file = parseConfigImport(input.value);
            this.plan = planConfigImport(this.plugin.settings, this.plugin.libraryManifest.load(), file);
            this.renderPlan();
          } catch (e) {
            new Notice((e as Error).message, 8_000);
          }
        }),
    );
  }

  private renderPlan(): void {
    const plan = this.plan;
    if (!plan) return;
    const { contentEl } = this;
    contentEl.empty();

    if (plan.changes.length === 0 && plan.newLibraries.length === 0) {
      contentEl.createEl("p", { text: "Nothing to import — this setup already matches." });
      if (plan.skipped.length > 0) this.renderSkipped(plan.skipped);
      return;
    }

    if (plan.changes.length > 0) {
      contentEl.createEl("h5", { text: "Settings that will change" });
      const list = contentEl.createDiv("covault-import-list");
      for (const c of plan.changes) {
        const row = list.createDiv("covault-import-row");
        row.createSpan({ cls: "covault-import-label", text: c.label });
        row.createSpan({ cls: "covault-import-delta", text: `${c.from} → ${c.to}` });
      }
    }

    if (plan.newLibraries.length > 0) {
      contentEl.createEl("h5", { text: `Libraries to add (${plan.newLibraries.length})` });
      const list = contentEl.createDiv("covault-import-list");
      for (const repo of plan.newLibraries) {
        const row = list.createDiv("covault-import-row");
        row.createSpan({ cls: "covault-import-label", text: repo.path });
        row.createSpan({ cls: "covault-import-delta", text: repo.description ?? repo.url });
      }
      if (plan.existingLibraries > 0) {
        contentEl.createEl("p", {
          cls: "covault-import-note",
          text: `${plan.existingLibraries} librar${plan.existingLibraries === 1 ? "y" : "ies"} already set up — left alone.`,
        });
      }
    }

    if (plan.skipped.length > 0) this.renderSkipped(plan.skipped);

    // Libraries are fetched from GitHub, so without access the import
    // would apply the settings and then fail on every one of them.
    const blocked = plan.newLibraries.length > 0 && !this.plugin.isSignedIn();
    if (blocked) {
      contentEl.createEl("p", {
        cls: "covault-import-blocked",
        text:
          "Sign in to GitHub before importing — these libraries can't be fetched without it. " +
          "Settings → Covault → GitHub, then come back.",
      });
    }

    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText("Back").onClick(() => this.renderPaste()))
      .addButton((btn) =>
        btn
          .setButtonText("Import")
          .setCta()
          .setDisabled(blocked)
          .onClick(() => {
            if (this.busy || blocked) return;
            this.busy = true;
            // Closed first, on purpose: setting up libraries is network
            // work that scales with how many there are, and the user
            // should not be held in a dialog while it runs. Progress and
            // failures arrive as notices.
            this.close();
            void this.plugin.applyConfigImport(plan).catch((e: Error) => {
              new Notice(`Covault: import failed — ${e.message}`, 10_000);
            });
          }),
      );
  }

  private renderSkipped(skipped: string[]): void {
    const { contentEl } = this;
    contentEl.createEl("h5", { text: "Not imported" });
    const list = contentEl.createDiv("covault-import-list");
    for (const reason of skipped) list.createDiv({ cls: "covault-import-note", text: reason });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

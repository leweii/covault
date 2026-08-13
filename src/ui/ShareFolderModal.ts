import { Modal, Notice, Setting, type App } from "obsidian";
import type CovaultPlugin from "../main";
import { createOrgRepo, RepoExistsError } from "../git/githubApi";
import { ConfirmModal } from "./ConfirmModal";

/**
 * "Share this folder as a knowledge library": pick the organization,
 * name the library, and Covault creates the repo, uploads the folder,
 * and starts keeping it in sync. No git vocabulary.
 */
export class ShareFolderModal extends Modal {
  private org = "";
  private repoName: string;
  private isPrivate = true;
  private busy = false;

  constructor(
    app: App,
    private plugin: CovaultPlugin,
    private folderPath: string,
  ) {
    super(app);
    this.repoName = folderPath.split("/").pop()?.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") ?? "knowledge";
  }

  onOpen(): void {
    this.titleEl.setText(`Share "${this.folderPath}"`);
    const { contentEl } = this;

    const orgs = this.plugin.settings.githubApp.connections
      .flatMap((c) => c.installations)
      .map((i) => i.accountLogin);

    if (orgs.length === 0) {
      contentEl.createEl("p", {
        text: "Connect to GitHub first (Settings → Covault), and install the app on your organization.",
      });
      return;
    }
    this.org = orgs[0] ?? "";

    new Setting(contentEl)
      .setName("Organization")
      .setDesc("Where teammates will find this library.")
      .addDropdown((dd) => {
        for (const o of orgs) dd.addOption(o, o);
        dd.setValue(this.org).onChange((v) => (this.org = v));
      });

    new Setting(contentEl)
      .setName("Library name")
      .addText((t) => t.setValue(this.repoName).onChange((v) => (this.repoName = v.trim())));

    new Setting(contentEl)
      .setName("Private")
      .setDesc("Only members of the organization can see it.")
      .addToggle((t) => t.setValue(this.isPrivate).onChange((v) => (this.isPrivate = v)));

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Share")
        .setCta()
        .onClick(() => void this.submit(btn.buttonEl)),
    );
  }

  private async submit(buttonEl: HTMLButtonElement): Promise<void> {
    if (this.busy || !this.org || !this.repoName) return;
    this.busy = true;
    buttonEl.disabled = true;
    buttonEl.setText("Sharing…");
    try {
      const token = await this.plugin.appAuth.getRepoCreationToken(this.org);
      let url: string;
      try {
        const repo = await createOrgRepo(token, this.org, this.repoName, this.isPrivate);
        url = repo.url;
      } catch (e) {
        if (!(e instanceof RepoExistsError)) throw e;
        const ok = await ConfirmModal.ask(this.app, {
          title: "Library already exists",
          message:
            `"${this.repoName}" already exists in ${this.org}. Connect this folder to it instead? ` +
            `The library's current contents will be pulled in and merged with the folder first.`,
          cta: "Connect and pull",
        });
        if (!ok) {
          this.busy = false;
          buttonEl.disabled = false;
          buttonEl.setText("Share");
          return;
        }
        url = `https://github.com/${this.org}/${this.repoName}.git`;
      }
      await this.plugin.attachExistingLibrary(this.folderPath, url, "main");
      new Notice(`Covault: "${this.folderPath}" is now shared as ${this.org}/${this.repoName}.`);
      this.close();
    } catch (e) {
      new Notice(`Covault: couldn't share the folder — ${(e as Error).message}`);
      buttonEl.disabled = false;
      buttonEl.setText("Share");
      this.busy = false;
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

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

  /**
   * Ask everything first, then get out of the way.
   *
   * Both questions this flow can need — the library already exists, the
   * folder is still linked elsewhere — are answered while the dialog is
   * still up, in order, so they read as part of the same decision. Only
   * once nothing is left to ask does the dialog close and the network work
   * (repo contents, first sync: tens of seconds) continue behind it.
   */
  private async submit(buttonEl: HTMLButtonElement): Promise<void> {
    if (this.busy || !this.org || !this.repoName) return;
    this.busy = true;
    buttonEl.disabled = true;
    buttonEl.setText("Checking…");
    const target = `${this.org}/${this.repoName}`;

    let url: string | null;
    try {
      url = await this.resolveTargetUrl();
      if (url && !(await this.clearFolderLink(url))) url = null;
    } catch (e) {
      console.error("[covault] share folder failed:", e);
      new Notice(`Covault: couldn't share "${this.folderPath}" — ${(e as Error).message}`, 12_000);
      this.reset(buttonEl);
      return;
    }
    if (!url) {
      // The user declined one of the questions — leave the dialog up so
      // they can change the name or the organization instead.
      this.reset(buttonEl);
      return;
    }

    this.close();
    new Notice(`Covault: sharing "${this.folderPath}" as ${target} in the background…`);
    try {
      await this.plugin.attachExistingLibrary(this.folderPath, url, "main");
      new Notice(`Covault: "${this.folderPath}" is now shared as ${target}.`);
    } catch (e) {
      console.error("[covault] share folder failed:", e);
      new Notice(`Covault: couldn't share "${this.folderPath}" — ${(e as Error).message}`, 12_000);
    }
  }

  private reset(buttonEl: HTMLButtonElement): void {
    this.busy = false;
    buttonEl.disabled = false;
    buttonEl.setText("Share");
  }

  /** Create the repo, or get permission to reuse one that already exists. */
  private async resolveTargetUrl(): Promise<string | null> {
    const token = await this.plugin.appAuth.getRepoCreationToken(this.org);
    try {
      return (await createOrgRepo(token, this.org, this.repoName, this.isPrivate)).url;
    } catch (e) {
      if (!(e instanceof RepoExistsError)) throw e;
      const ok = await ConfirmModal.ask(this.app, {
        title: "Library already exists",
        message:
          `"${this.repoName}" already exists in ${this.org}. Connect this folder to it instead? ` +
          `The library's current contents will be pulled in and merged with the folder first.`,
        cta: "Connect and pull",
      });
      return ok ? `https://github.com/${this.org}/${this.repoName}.git` : null;
    }
  }

  /**
   * A folder that used to be a different library still carries its
   * address; sharing over it would repoint that origin. Asked here rather
   * than caught mid-attach. True = clear to proceed.
   */
  private async clearFolderLink(url: string): Promise<boolean> {
    const origin = await this.plugin.conflictingOrigin(this.folderPath, url);
    if (!origin) return true;
    const ok = await ConfirmModal.ask(this.app, {
      title: "Folder is linked to a previous library",
      message:
        `"${this.folderPath}" is still linked to ${origin}. ` +
        `Unlink it and share as a new library? Your notes stay untouched.`,
      cta: "Unlink and share",
    });
    if (!ok) return false;
    this.plugin.unlinkFolder(this.folderPath);
    return true;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

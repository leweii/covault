import { Modal, Notice, Setting, type App } from "obsidian";
import type CovaultPlugin from "../main";
import { createOrgRepo, RepoExistsError } from "../git/githubApi";
import { FolderLinkedError } from "../covault/errors";
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
   * Hand the work off and get out of the way.
   *
   * Creating the repo, adopting its content and the first sync are all
   * network work measured in tens of seconds, and the user has already
   * told us everything we need. So the dialog closes immediately and the
   * rest runs behind it, reporting through notices.
   *
   * The two questions this flow can still need — the library already
   * exists, or the folder is linked elsewhere — are their own modals, so
   * they surface fine after this one is gone.
   */
  private async submit(buttonEl: HTMLButtonElement): Promise<void> {
    if (this.busy || !this.org || !this.repoName) return;
    this.busy = true;
    buttonEl.disabled = true;
    const target = `${this.org}/${this.repoName}`;
    this.close();
    new Notice(`Covault: sharing "${this.folderPath}" as ${target} in the background…`);
    try {
      await this.share();
      new Notice(`Covault: "${this.folderPath}" is now shared as ${target}.`);
    } catch (e) {
      console.error("[covault] share folder failed:", e);
      new Notice(`Covault: couldn't share "${this.folderPath}" — ${(e as Error).message}`, 12_000);
    }
  }

  /** The share itself. Throws; submit() owns the reporting. */
  private async share(): Promise<void> {
    const url = await this.resolveTargetUrl();
    if (!url) return; // the user declined to reuse an existing library
    try {
      await this.plugin.attachExistingLibrary(this.folderPath, url, "main");
    } catch (e) {
      // The folder still carries the link of a library it used to be —
      // offer to unlink it (the notes are untouched) and share fresh.
      if (!(e instanceof FolderLinkedError)) throw e;
      const ok = await ConfirmModal.ask(this.app, {
        title: "Folder is linked to a previous library",
        message:
          `"${this.folderPath}" is still linked to ${e.origin}. ` +
          `Unlink it and share as a new library? Your notes stay untouched.`,
        cta: "Unlink and share",
      });
      if (!ok) throw e;
      this.plugin.unlinkFolder(this.folderPath);
      await this.plugin.attachExistingLibrary(this.folderPath, url, "main");
    }
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

  onClose(): void {
    this.contentEl.empty();
  }
}

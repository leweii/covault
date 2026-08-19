import { Modal, Notice, Setting, type App } from "obsidian";
import type CovaultPlugin from "../main";
import { RepoExistsError } from "../git/githubApi";
import { FolderLinkedError } from "../covault/errors";
import { ConfirmModal } from "./ConfirmModal";

const CREATE_NEW = "\u0000create-new";

/**
 * Guided "Add a shared library" flow:
 *   1. organization (defaults to the base org from settings)
 *   2. one of that org's repositories — or "Create a new library"
 *   3. where it lives in the vault
 * PAT mode (no App installations) falls back to pasting an address.
 */
export class AddLibraryModal extends Modal {
  private org = "";
  private choice = ""; // repo full name, CREATE_NEW, or "" (none yet)
  private newName = "";
  private manualUrl = "";
  private folder = "";
  private folderTouched = false;
  private branch = "main";
  private busy = false;

  private reposByOrg = new Map<string, string[]>();
  private repoStepEl!: HTMLElement;

  constructor(
    app: App,
    private plugin: CovaultPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Add a shared library");
    const { contentEl } = this;
    const s = this.plugin.settings;

    const orgs = [...new Set(s.githubApp.connections.flatMap((c) => c.installations.map((i) => i.accountLogin)))];

    if (orgs.length === 0) {
      // PAT / not-connected fallback: manual address entry.
      contentEl.createEl("p", {
        text: "No GitHub connection found — paste the library's address instead.",
      });
      new Setting(contentEl)
        .setName("Address")
        .addText((t) => t.setPlaceholder("https://github.com/org/repo.git").onChange((v) => (this.manualUrl = v.trim())));
      this.renderFolderAndSubmit(contentEl);
      return;
    }

    this.org = orgs.includes(s.baseOrg) ? s.baseOrg : (orgs[0] ?? "");

    new Setting(contentEl)
      .setName("Organization")
      .setDesc("Knowledge repos live in your team's base organization.")
      .addDropdown((dd) => {
        for (const o of orgs) dd.addOption(o, o);
        dd.setValue(this.org).onChange((v) => {
          this.org = v;
          this.choice = "";
          this.renderRepoStep();
        });
      });

    this.repoStepEl = contentEl.createDiv();
    this.renderRepoStep();

    this.renderFolderAndSubmit(contentEl);

    void this.loadRepos();
  }

  private async loadRepos(): Promise<void> {
    const groups = await this.plugin.appAuth.listAccessibleRepos();
    for (const g of groups) this.reposByOrg.set(g.login, g.repos);
    // Preselect the first library so the folder suggestion is filled in
    // before the user touches anything.
    if (!this.choice) {
      const first = this.reposByOrg.get(this.org)?.[0];
      if (first) this.choice = first;
    }
    this.renderRepoStep();
    this.suggestFolder();
  }

  private renderRepoStep(): void {
    if (!this.repoStepEl) return;
    this.repoStepEl.empty();
    const repos = this.reposByOrg.get(this.org);

    const setting = new Setting(this.repoStepEl)
      .setName("Library")
      .setDesc(repos ? `Libraries in ${this.org}, or create a new one.` : `Loading libraries in ${this.org}…`);

    setting.addDropdown((dd) => {
      dd.addOption("", "— choose —");
      for (const name of repos ?? []) dd.addOption(name, name.split("/")[1] ?? name);
      dd.addOption(CREATE_NEW, "➕ Create a new library…");
      dd.setValue(this.choice).onChange((v) => {
        this.choice = v;
        if (v !== CREATE_NEW) this.folderTouched = false; // re-suggest for the new pick
        this.renderRepoStep();
        this.suggestFolder();
      });
    });

    if (this.choice === CREATE_NEW) {
      new Setting(this.repoStepEl)
        .setName("New library name")
        .addText((t) =>
          t
            .setPlaceholder("platform-kb")
            .setValue(this.newName)
            .onChange((v) => {
              this.newName = v.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
              this.suggestFolder();
            }),
        );
    }
  }

  private folderInput: HTMLInputElement | null = null;

  private suggestFolder(): void {
    if (this.folderTouched) return;
    const name = this.choice === CREATE_NEW ? this.newName : (this.choice.split("/")[1] ?? "");
    if (!name) return;
    this.folder = `teams/${name}`;
    if (this.folderInput) this.folderInput.value = this.folder;
  }

  private renderFolderAndSubmit(el: HTMLElement): void {
    new Setting(el)
      .setName("Folder in your vault")
      .setDesc("Where the library's notes will live.")
      .addText((t) => {
        this.folderInput = t.inputEl;
        t.setPlaceholder("teams/platform-kb").onChange((v) => {
          this.folder = v.trim().replace(/^\/+|\/+$/g, "");
          this.folderTouched = true;
        });
      });

    new Setting(el).addButton((btn) =>
      btn
        .setButtonText("Add")
        .setCta()
        .onClick(() => void this.submit(btn.buttonEl)),
    );
  }

  private async submit(buttonEl: HTMLButtonElement): Promise<void> {
    if (this.busy || !this.folder) return;
    const s = this.plugin.settings;
    this.busy = true;
    buttonEl.disabled = true;
    buttonEl.setText("Adding…");
    try {
      if (this.org && !s.baseOrg) {
        s.baseOrg = this.org;
        await this.plugin.saveSettings();
      }
      if (this.choice === CREATE_NEW) {
        if (!this.newName) throw new Error("give the new library a name first.");
        try {
          await this.plugin.createSharedLibrary(this.org, this.newName, this.folder);
          new Notice(`Covault: "${this.folder}" created and shared in ${this.org}.`);
        } catch (e) {
          if (!(e instanceof RepoExistsError)) throw e;
          const ok = await ConfirmModal.ask(this.app, {
            title: "Library already exists",
            message:
              `"${this.newName}" already exists in ${this.org}. Add it to your vault instead? ` +
              `Its current contents will be pulled into "${this.folder}".`,
            cta: "Add and pull",
          });
          if (!ok) {
            this.busy = false;
            buttonEl.disabled = false;
            buttonEl.setText("Add");
            return;
          }
          await this.plugin.attachExistingLibrary(
            this.folder,
            `https://github.com/${this.org}/${this.newName}.git`,
            this.branch,
          );
          new Notice(`Covault: "${this.folder}" connected to the existing library.`);
        }
      } else {
        const url = this.choice ? `https://github.com/${this.choice}.git` : this.manualUrl;
        if (!url) throw new Error("pick a library first.");
        await this.plugin.addLibrary({ path: this.folder, url, branch: this.branch });
        new Notice(`Covault: "${this.folder}" will fill up on the next sync (running now).`);
      }
      this.close();
    } catch (e) {
      if (e instanceof FolderLinkedError) {
        const url =
          this.choice === CREATE_NEW
            ? `https://github.com/${this.org}/${this.newName}.git`
            : this.choice
              ? `https://github.com/${this.choice}.git`
              : this.manualUrl;
        const ok = await ConfirmModal.ask(this.app, {
          title: "Folder is linked to a previous library",
          message:
            `"${this.folder}" is still linked to ${e.origin}. ` +
            `Unlink it and connect to this library instead? Your notes stay untouched.`,
          cta: "Unlink and connect",
        });
        if (ok && url) {
          try {
            this.plugin.unlinkFolder(this.folder);
            await this.plugin.attachExistingLibrary(this.folder, url, this.branch);
            new Notice(`Covault: "${this.folder}" connected.`);
            this.close();
            return;
          } catch (e2) {
            console.error("[covault] add after unlink failed:", e2);
            new Notice(`Covault: couldn't add the library — ${(e2 as Error).message}`);
          }
        }
      } else {
        console.error("[covault] add library failed:", e);
        new Notice(`Covault: couldn't add the library — ${(e as Error).message}`);
      }
      buttonEl.disabled = false;
      buttonEl.setText("Add");
      this.busy = false;
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

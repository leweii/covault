import { Modal, Notice, Setting, type App } from "obsidian";
import { repoExists, RepoExistsError } from "../git/githubApi";
import { ownerFromUrl, repoNameFromUrl } from "../git/urls";
import { FolderLinkedError } from "../covault/errors";
import type CovaultPlugin from "../main";
import { ConfirmModal } from "./ConfirmModal";

const CREATE_NEW = "\u0000create-new";
const OTHER_ORG = "\u0000other-org";

/**
 * Guided "Add a shared library" flow:
 *   1. organization — picked explicitly every time, nothing prefilled; or
 *      "Other…", which replaces the pickers with a single GitHub link. The
 *      listing only covers orgs whose installation this account can see, and
 *      a library can sit outside that set (a private repo the narrowed token
 *      misses, an installation that hasn't been refreshed yet) — a link
 *      identifies it without either picker.
 *   2. one of that org's repositories — or "Create a new library"
 *   3. where it lives in the vault
 * PAT mode (no App installations) falls back to pasting an address.
 */
export class AddLibraryModal extends Modal {
  /** Dropdown selection: an org login, or OTHER_ORG for typed entry. */
  private orgChoice = "";
  /** The GitHub link pasted under "Other…". */
  private manualLink = "";
  private choice = ""; // repo full name, CREATE_NEW, or "" (none yet)
  private newName = "";
  private manualUrl = "";
  private folder = "";
  private folderTouched = false;
  private branch = "main";
  private busy = false;

  private reposByOrg = new Map<string, string[]>();
  /** Per-org listing failure, so the dropdown can say so instead of looking empty. */
  private errorByOrg = new Map<string, string>();
  private loading = true;
  private loadError = "";

  private repoStepEl!: HTMLElement;

  constructor(
    app: App,
    private plugin: CovaultPlugin,
  ) {
    super(app);
  }

  private get orgIsManual(): boolean {
    return this.orgChoice === OTHER_ORG;
  }

  /** The organization this flow targets ("" until a link parses). */
  private get org(): string {
    return this.orgIsManual ? (this.manualTarget()?.owner ?? "") : this.orgChoice;
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

    new Setting(contentEl)
      .setName("Organization")
      .setDesc("Which organization this library belongs to.")
      .addDropdown((dd) => {
        dd.addOption("", "— choose —");
        for (const o of orgs) dd.addOption(o, o);
        dd.addOption(OTHER_ORG, "Other… (paste a link)");
        dd.setValue(this.orgChoice).onChange((v) => {
          this.orgChoice = v;
          this.choice = "";
          this.renderRepoStep();
          this.suggestFolder();
        });
      });

    this.repoStepEl = contentEl.createDiv();
    this.renderRepoStep();

    this.renderFolderAndSubmit(contentEl);

    void this.loadRepos();
  }

  private async loadRepos(): Promise<void> {
    try {
      const groups = await this.plugin.appAuth.listAccessibleRepos();
      for (const g of groups) {
        this.reposByOrg.set(g.login, g.repos);
        if (g.error) this.errorByOrg.set(g.login, g.error);
      }
    } catch (e) {
      this.loadError = (e as Error).message || "Couldn't reach GitHub";
    }
    this.loading = false;
    // Preselect the first library so the folder suggestion is filled in
    // before the user touches anything.
    if (!this.choice && !this.orgIsManual) {
      const first = this.reposByOrg.get(this.org)?.[0];
      if (first) this.choice = first;
    }
    this.renderRepoStep();
    this.suggestFolder();
  }

  private renderRepoStep(): void {
    if (!this.repoStepEl) return;
    this.repoStepEl.empty();

    if (this.orgIsManual) {
      new Setting(this.repoStepEl)
        .setName("GitHub link")
        .setDesc("Paste the library's address from GitHub — the organization and name come from it.")
        .addText((t) => {
          t.inputEl.addClass("covault-wide-input");
          t.setPlaceholder("https://github.com/ct-kb/platform-kb")
            .setValue(this.manualLink)
            .onChange((v) => {
              this.manualLink = v.trim();
              this.suggestFolder();
            });
        });
      return;
    }

    if (!this.org) {
      new Setting(this.repoStepEl)
        .setName("Library")
        .setDesc("Choose an organization first.")
        .addDropdown((dd) => {
          dd.addOption("", "— choose an organization —");
          dd.setValue("").setDisabled(true);
        });
      return;
    }

    const repos = this.reposByOrg.get(this.org);
    const error = this.loadError || this.errorByOrg.get(this.org) || "";
    const state = this.loading ? "loading" : error && !repos?.length ? "error" : "ready";

    const setting = new Setting(this.repoStepEl).setName("Library").setDesc(
      state === "loading"
        ? `Loading libraries in ${this.org}…`
        : state === "error"
          ? `Couldn't load ${this.org}'s libraries — ${error}. Pick "Other…" above to type the name.`
          : repos?.length
            ? `Libraries in ${this.org}, or create a new one.`
            : `No libraries in ${this.org} yet — create one, or pick "Other…" above.`,
    );

    setting.addDropdown((dd) => {
      if (state === "loading") {
        // The only option, and unpickable: the list is still on its way.
        dd.addOption("", "⏳ Loading libraries…");
        dd.setValue("").setDisabled(true);
        return;
      }
      dd.addOption("", state === "error" ? "⚠️ Couldn't load libraries" : "— choose —");
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

  /**
   * Owner + name out of the pasted link. Tolerant about how it was copied:
   * with or without the scheme, a trailing ".git", a trailing slash, or the
   * bare "owner/name" that GitHub's own UI shows.
   */
  private manualTarget(): { owner: string; repo: string } | null {
    const raw = this.manualLink
      .trim()
      .replace(/^@/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "");
    if (!raw) return null;
    if (/^git@/i.test(raw)) return null; // SSH: no transport for it
    if (/^https?:\/\//i.test(raw) || /^[\w.-]+\.[\w.-]+\//.test(raw)) {
      const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      try {
        return { owner: ownerFromUrl(url), repo: repoNameFromUrl(url) };
      } catch {
        return null;
      }
    }
    const parts = raw.split("/").filter(Boolean);
    return parts.length >= 2 ? { owner: parts[0] ?? "", repo: parts[1] ?? "" } : null;
  }

  /** Where the chosen library lives, whichever path picked it. */
  private targetUrl(): string {
    if (this.orgIsManual) {
      const t = this.manualTarget();
      return t ? `https://github.com/${t.owner}/${t.repo}.git` : "";
    }
    if (this.choice === CREATE_NEW) return `https://github.com/${this.org}/${this.newName}.git`;
    return this.choice ? `https://github.com/${this.choice}.git` : this.manualUrl;
  }

  private folderInput: HTMLInputElement | null = null;

  private suggestFolder(): void {
    if (this.folderTouched) return;
    const name = this.orgIsManual
      ? (this.manualTarget()?.repo ?? "")
      : this.choice === CREATE_NEW
        ? this.newName
        : (this.choice.split("/")[1] ?? "");
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
    this.busy = true;
    buttonEl.disabled = true;
    buttonEl.setText("Adding…");
    try {
      if (!this.org) throw new Error("choose an organization first.");
      if (this.orgIsManual) {
        const target = this.manualTarget();
        if (!target) throw new Error("paste the library's GitHub link (https://github.com/org/name).");
        // Checked here rather than left to the first background sync: a
        // typo and a missing installation look identical from the panel.
        const token = await this.plugin.appAuth.getTokenForOwner(target.owner);
        if (!(await repoExists(token, target.owner, target.repo))) {
          throw new Error(
            `${target.owner}/${target.repo} isn't there, or Covault can't see it — ` +
              `check the spelling, and that the app is installed on ${target.owner} with access to it.`,
          );
        }
        await this.plugin.addLibrary({ path: this.folder, url: this.targetUrl(), branch: this.branch });
        new Notice(`Covault: "${this.folder}" will fill up on the next sync (running now).`);
      } else if (this.choice === CREATE_NEW) {
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
          await this.plugin.attachExistingLibrary(this.folder, this.targetUrl(), this.branch);
          new Notice(`Covault: "${this.folder}" connected to the existing library.`);
        }
      } else {
        const url = this.targetUrl();
        if (!url) throw new Error("pick a library first.");
        await this.plugin.addLibrary({ path: this.folder, url, branch: this.branch });
        new Notice(`Covault: "${this.folder}" will fill up on the next sync (running now).`);
      }
      this.close();
    } catch (e) {
      if (e instanceof FolderLinkedError) {
        const url = this.targetUrl();
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

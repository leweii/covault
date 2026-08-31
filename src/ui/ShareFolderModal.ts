import { Modal, Notice, Setting, type App } from "obsidian";
import { createOrgRepo, RepoExistsError } from "../git/githubApi";
import { repoNameFromUrl } from "../git/urls";
import type CovaultPlugin from "../main";
import { ConfirmModal } from "./ConfirmModal";
import { MainKbModal } from "./MainKbModal";

type Dest = "personal" | "team";

/**
 * "Share this folder" — two destinations behind one dialog.
 *
 * Your own knowledge base is the default and the common case: nothing to
 * decide, one confirmation, the folder starts syncing to your personal
 * repo. A new team library is the deliberate act, so it asks for the
 * organization every time — there is no stored default organization to
 * fall back on, because "which team owns this" is not a property of the
 * vault. No git vocabulary either way.
 */
export class ShareFolderModal extends Modal {
  private dest: Dest = "personal";
  private org = "";
  private repoName: string;
  private isPrivate = true;
  private busy = false;
  private orgs: string[] = [];
  private tabButtons: HTMLButtonElement[] = [];
  private bodyEl!: HTMLElement;
  private footerEl!: HTMLElement;

  constructor(
    app: App,
    private plugin: CovaultPlugin,
    private folderPath: string,
  ) {
    super(app);
    this.repoName = folderPath.split("/").pop()?.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") ?? "knowledge";
  }

  onOpen(): void {
    this.modalEl.addClass("covault-setup-modal");
    this.titleEl.setText(`Share "${this.folderPath}"`);
    const { contentEl } = this;
    contentEl.empty();

    this.orgs = [
      ...new Set(this.plugin.settings.githubApp.connections.flatMap((c) => c.installations).map((i) => i.accountLogin)),
    ];
    if (this.orgs.length === 0 && !this.plugin.settings.mainRepo) {
      contentEl.createEl("p", {
        text: "Connect to GitHub first (Settings → Covault), and install the app on your organization.",
      });
      return;
    }

    // Personal first unless this folder is already covered there.
    const state = this.personalState();
    this.dest = state === "ready" || state === "needsSetup" ? "personal" : "team";

    const tabs = contentEl.createDiv("covault-tabs");
    const tab = (label: string, dest: Dest) => {
      const btn = tabs.createEl("button", {
        text: label,
        cls: "covault-tab" + (this.dest === dest ? " is-active" : ""),
      });
      btn.onclick = () => {
        if (this.dest === dest || this.busy) return;
        this.dest = dest;
        for (const b of this.tabButtons) b.toggleClass("is-active", b === btn);
        this.renderBody();
      };
      this.tabButtons.push(btn);
    };
    tab("My knowledge base", "personal");
    tab("A new team library", "team");

    this.bodyEl = contentEl.createDiv("covault-setup-body");
    this.footerEl = contentEl.createDiv("covault-setup-footer");
    this.renderBody();
  }

  /** Why the personal path may not be available for this folder. */
  private personalState(): "ready" | "needsSetup" | "alreadyShared" | "wholeVault" {
    if (!this.plugin.settings.mainRepo) return "needsSetup";
    if (this.plugin.mainKbScope() === "vault") return "wholeVault";
    if (this.plugin.isSharedToMainKb(this.folderPath)) return "alreadyShared";
    return "ready";
  }

  private renderBody(): void {
    this.bodyEl.empty();
    this.footerEl.empty();
    const cta = this.dest === "personal" ? this.renderPersonal() : this.renderTeam();
    new Setting(this.footerEl).setClass("covault-setup-actions").addButton((btn) => {
      btn.setButtonText(cta.label).setCta().onClick(cta.onClick);
      btn.setDisabled(!cta.enabled || this.busy);
    });
  }

  private note(text: string): void {
    this.bodyEl.createDiv("covault-setup-status", (el) => el.setText(text));
  }

  private renderPersonal(): { label: string; enabled: boolean; onClick: () => void } {
    const mainRepo = this.plugin.settings.mainRepo;
    switch (this.personalState()) {
      case "needsSetup":
        this.note("Your knowledge base isn't set up yet — that takes one dialog, then this folder can go in.");
        return {
          label: "Set it up…",
          enabled: true,
          onClick: () => {
            this.close();
            new MainKbModal(this.app, this.plugin).open();
          },
        };
      case "wholeVault":
        this.note(
          `Everything in this vault already backs up to ${this.repoLabel(mainRepo?.url)} — ` +
            `this folder is included, nothing to do.`,
        );
        return { label: "Already backed up", enabled: false, onClick: () => {} };
      case "alreadyShared":
        this.note(`"${this.folderPath}" already syncs to ${this.repoLabel(mainRepo?.url)}.`);
        return { label: "Already shared", enabled: false, onClick: () => {} };
      default:
        this.note(
          `"${this.folderPath}" will sync to ${this.repoLabel(mainRepo?.url)}, your own knowledge base. ` +
            `Nothing else in your vault is affected, and no teammate gets it.`,
        );
        return {
          label: "Share",
          enabled: true,
          onClick: () => {
            this.plugin.markSharedToMainKb(this.folderPath);
            new Notice(`Covault: "${this.folderPath}" now syncs to your knowledge base.`);
            this.close();
          },
        };
    }
  }

  private repoLabel(url: string | undefined): string {
    if (!url) return "your knowledge base";
    try {
      return repoNameFromUrl(url);
    } catch {
      return "your knowledge base";
    }
  }

  private renderTeam(): { label: string; enabled: boolean; onClick: () => void } {
    if (this.orgs.length === 0) {
      this.note("Install Covault on an organization first (Settings → Covault → Install on GitHub).");
      return { label: "Share", enabled: false, onClick: () => {} };
    }

    this.note("Creates a new library in the organization and uploads this folder. Teammates can then add it.");

    new Setting(this.bodyEl)
      .setName("Organization")
      .setDesc("Where teammates will find this library.")
      .addDropdown((dd) => {
        dd.addOption("", "— choose —");
        for (const o of this.orgs) dd.addOption(o, o);
        dd.setValue(this.org).onChange((v) => {
          this.org = v;
          this.renderBody(); // the button waits on this answer
        });
      });

    new Setting(this.bodyEl)
      .setName("Library name")
      .addText((t) =>
        t.setValue(this.repoName).onChange((v) => {
          const had = !!this.repoName;
          this.repoName = v.trim();
          if (had !== !!this.repoName) this.renderBody();
        }),
      );

    new Setting(this.bodyEl)
      .setName("Private")
      .setDesc("Only members of the organization can see it.")
      .addToggle((t) => t.setValue(this.isPrivate).onChange((v) => (this.isPrivate = v)));

    return {
      label: "Share",
      enabled: !!this.org && !!this.repoName,
      onClick: () => void this.submitTeam(),
    };
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
  private async submitTeam(): Promise<void> {
    if (this.busy || !this.org || !this.repoName) return;
    this.busy = true;
    this.renderBody();
    const target = `${this.org}/${this.repoName}`;

    let url: string | null;
    try {
      url = await this.resolveTargetUrl();
      if (url && !(await this.clearFolderLink(url))) url = null;
    } catch (e) {
      console.error("[covault] share folder failed:", e);
      new Notice(`Covault: couldn't share "${this.folderPath}" — ${(e as Error).message}`, 12_000);
      this.busy = false;
      this.renderBody();
      return;
    }
    if (!url) {
      // The user declined one of the questions — leave the dialog up so
      // they can change the name or the organization instead.
      this.busy = false;
      this.renderBody();
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

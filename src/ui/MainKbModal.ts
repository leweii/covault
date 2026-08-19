import { Modal, Notice, Setting, type App } from "obsidian";
import type CovaultPlugin from "../main";
import type { MainKbScope } from "../covault/manifest";
import { addCollaborator, createOrgRepo, repoExists, RepoExistsError } from "../git/githubApi";

type Mode = "existing" | "create";

/**
 * Guided personal knowledge base setup, with two paths that both avoid
 * merge conflicts entirely (setup often happens before an AI provider is
 * configured, so there'd be nothing to resolve them with):
 *
 *   existing → pick one of the org's knowledge bases; its content wins
 *              and is pulled in, local versions of overlapping notes are
 *              kept aside as "(local copy <timestamp>)".
 *   create   → name one that doesn't exist yet; your marked notes become
 *              its first commit, so there is nothing to conflict.
 *
 * Both tabs render the same shape (control row + status line) so switching
 * between them never resizes the dialog; the scope picker and the action
 * button sit below in a shared footer.
 */
export class MainKbModal extends Modal {
  private mode: Mode = "existing";
  private repos: string[] | null; // null = no list yet
  private selected = "";
  private name: string;
  private nameState: "idle" | "checking" | "free" | "taken" | "unknown" = "idle";
  private token = "";
  private busy = false;
  private debounceId: number | null = null;
  private bodyEl!: HTMLElement;
  private footerEl!: HTMLElement;
  private kbScope: MainKbScope; // not `scope`: Modal.scope is the keymap scope
  private ctaBtn: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private plugin: CovaultPlugin,
  ) {
    super(app);
    const login = plugin.settings.githubApp.connections[0]?.login ?? "";
    this.name = `personal-kb-${login.toLowerCase()}`;
    this.kbScope = plugin.mainKbScope();
    // Start from the warm cache so the dropdown is filled immediately.
    this.repos = plugin.cachedOrgRepos();
    if (this.repos) this.selected = pickDefault(this.repos);
  }

  onOpen(): void {
    this.modalEl.addClass("covault-setup-modal");
    this.titleEl.setText("Set up your personal knowledge base");
    const { contentEl } = this;
    contentEl.empty();

    if (!this.plugin.settings.baseOrg) {
      contentEl.createEl("p", { text: "Choose a base organization first (Settings → Covault → GitHub)." });
      return;
    }

    const tabs = contentEl.createDiv("covault-tabs");
    const tab = (label: string, mode: Mode) => {
      const btn = tabs.createEl("button", {
        text: label,
        cls: "covault-tab" + (this.mode === mode ? " is-active" : ""),
      });
      btn.onclick = () => {
        if (this.mode === mode) return;
        this.mode = mode;
        tabs.querySelectorAll(".covault-tab").forEach((el, i) => {
          el.toggleClass("is-active", (i === 0) === (this.mode === "existing"));
        });
        this.renderBody();
        if (mode === "create" && this.nameState === "idle") void this.checkName();
      };
    };
    tab("Use an existing KB", "existing");
    tab("Create a new KB", "create");

    this.bodyEl = contentEl.createDiv("covault-setup-body");
    this.footerEl = contentEl.createDiv("covault-setup-footer");
    this.renderBody();

    // Refresh in the background: the cache may predate something the user
    // created elsewhere.
    void this.plugin.fetchOrgRepos().then((repos) => {
      this.repos = repos;
      if (!this.selected) this.selected = pickDefault(repos);
      this.renderBody();
    });
  }

  onClose(): void {
    if (this.debounceId !== null) window.clearTimeout(this.debounceId);
    this.contentEl.empty();
  }

  private renderBody(): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    this.footerEl.empty();
    const cta = this.mode === "existing" ? this.renderExisting() : this.renderCreate();
    this.renderScope();
    this.cta(cta.label, cta.onClick, cta.enabled);
  }

  /** How much of the vault this knowledge base will hold. Team libraries
   *  stay out of it either way — they sync to their own repos, and a note
   *  living in both would be pushed twice. */
  private renderScope(): void {
    new Setting(this.footerEl)
      .setName("Back up")
      .setDesc("Team libraries always stay in their own libraries.")
      .addDropdown((dd) =>
        dd
          .addOption("marked", "Only notes I mark")
          .addOption("vault", "Everything in this vault")
          .setValue(this.kbScope)
          .onChange((v) => (this.kbScope = v === "vault" ? "vault" : "marked")),
      );
  }

  private renderExisting(): Cta {
    const org = this.plugin.settings.baseOrg;
    const repos = this.repos;

    const setting = new Setting(this.bodyEl).setName("Knowledge base");
    if (repos !== null && repos.length > 0) {
      setting.addDropdown((dd) => {
        for (const r of repos) dd.addOption(r, r);
        dd.setValue(this.selected).onChange((v) => (this.selected = v));
      });
    }

    const status = this.bodyEl.createDiv("covault-setup-status");
    if (repos === null) status.setText("Loading…");
    else if (repos.length === 0) status.setText(`Nothing in ${org} yet — create one instead.`);
    else status.setText(`${repos.length} available in ${org}.`);

    return {
      label: "Connect and pull",
      onClick: () => void this.submit("adopt"),
      enabled: repos !== null && repos.length > 0,
    };
  }

  private renderCreate(): Cta {
    new Setting(this.bodyEl).setName("Knowledge base").addText((t) =>
      t.setValue(this.name).onChange((v) => {
        this.name = v.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
        this.scheduleNameCheck();
      }),
    );

    const status = this.bodyEl.createDiv("covault-setup-status");
    switch (this.nameState) {
      case "checking":
        status.setText("Checking…");
        break;
      case "free":
        status.setText(`✨ ${this.name} is available.`);
        break;
      case "taken":
        status.setText(`⚠ ${this.name} already exists — pick another name.`);
        break;
      case "unknown":
        status.setText("Couldn't check the name.");
        break;
      default:
        status.setText("Enter a name.");
    }

    return {
      label: "Create and connect",
      onClick: () => void this.submit("create"),
      enabled: this.nameState !== "taken" && !!this.name,
    };
  }

  private cta(label: string, onClick: () => void, enabled: boolean): void {
    new Setting(this.footerEl).setClass("covault-setup-actions").addButton((btn) => {
      btn.setButtonText(label).setCta().onClick(onClick);
      btn.setDisabled(!enabled || this.busy);
      this.ctaBtn = btn.buttonEl;
    });
  }

  private scheduleNameCheck(): void {
    if (this.debounceId !== null) window.clearTimeout(this.debounceId);
    // The cached list answers instantly; the API is only needed when we
    // have no list to consult.
    if (this.repos) {
      this.nameState = this.name ? (this.repos.includes(this.name) ? "taken" : "free") : "idle";
      this.renderBody();
      return;
    }
    this.nameState = "checking";
    this.renderBody();
    this.debounceId = window.setTimeout(() => void this.checkName(), 400);
  }

  private async checkName(): Promise<void> {
    const org = this.plugin.settings.baseOrg;
    if (!this.name) {
      this.nameState = "idle";
      this.renderBody();
      return;
    }
    if (this.repos) {
      this.nameState = this.repos.includes(this.name) ? "taken" : "free";
      this.renderBody();
      return;
    }
    this.nameState = "checking";
    this.renderBody();
    try {
      if (!this.token) this.token = await this.plugin.appAuth.getRepoCreationToken(org);
      this.nameState = (await repoExists(this.token, org, this.name)) ? "taken" : "free";
    } catch {
      this.nameState = "unknown"; // offline etc — submit re-validates
    }
    this.renderBody();
  }

  private async submit(mode: "adopt" | "create"): Promise<void> {
    if (this.busy) return;
    const s = this.plugin.settings;
    const org = s.baseOrg;
    const login = s.githubApp.connections[0]?.login;
    const repoName = mode === "adopt" ? this.selected : this.name;
    if (!repoName) return;

    this.busy = true;
    const btn = this.ctaBtn;
    const idle = btn?.textContent ?? "Set up";
    if (btn) {
      btn.disabled = true;
      btn.setText("Setting up…");
    }
    try {
      if (mode === "create") {
        const token = this.token || (await this.plugin.appAuth.getRepoCreationToken(org));
        try {
          await createOrgRepo(token, org, repoName, true);
        } catch (e) {
          if (e instanceof RepoExistsError) {
            throw new Error(`"${repoName}" already exists — pick another name or use the existing tab.`);
          }
          throw e;
        }
        if (login) {
          // The App created the repo, so grant the human owner write access.
          // Other org members keep the org's default (read-only) permission.
          try {
            await addCollaborator(token, org, repoName, login, "admin");
          } catch (e) {
            console.warn("[covault] couldn't add owner as collaborator:", e);
          }
        }
        this.plugin.invalidateRepoCache();
      }

      // Scope first: "create" builds the very first commit from it.
      this.plugin.libraryManifest.setScope(this.kbScope);
      await this.plugin.setupMainKb(`https://github.com/${org}/${repoName}.git`, "main", mode);
      new Notice(`Covault: your personal knowledge base is connected to ${org}/${repoName}.`);
      this.close();
    } catch (e) {
      console.error("[covault] personal KB setup failed:", e);
      new Notice(`Covault: setup failed — ${(e as Error).message}`, 10_000);
      this.busy = false;
      if (btn) {
        btn.disabled = false;
        btn.setText(idle);
      }
    }
  }
}

interface Cta {
  label: string;
  onClick: () => void;
  enabled: boolean;
}

/** Personal KBs are what this dialog is usually for — prefer one. */
function pickDefault(repos: string[]): string {
  return repos.find((r) => r.startsWith("personal-kb-")) ?? repos[0] ?? "";
}

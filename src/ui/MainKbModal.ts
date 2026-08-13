import { Modal, Notice, Setting, type App } from "obsidian";
import type CovaultPlugin from "../main";
import { addCollaborator, createOrgRepo, repoExists, RepoExistsError } from "../git/githubApi";

type Mode = "existing" | "create";

/**
 * Guided personal knowledge base setup, with two paths that both avoid
 * merge conflicts entirely (setup often happens before an AI provider is
 * configured, so there'd be nothing to resolve them with):
 *
 *   existing → pick one of your org's repos; its content wins and is
 *              pulled in, local versions of overlapping notes are kept
 *              aside as "(local copy)".
 *   create   → name a repo that doesn't exist yet; your marked notes
 *              become its first commit, so there is nothing to conflict.
 */
export class MainKbModal extends Modal {
  private mode: Mode = "create";
  private repos: string[] | null = null; // null = still loading
  private selected = "";
  private name: string;
  private nameState: "idle" | "checking" | "free" | "taken" | "unknown" = "idle";
  private token = "";
  private busy = false;
  private debounceId: number | null = null;
  private bodyEl!: HTMLElement;

  constructor(
    app: App,
    private plugin: CovaultPlugin,
  ) {
    super(app);
    const login = plugin.settings.githubApp.connections[0]?.login ?? "";
    this.name = `personal-kb-${login.toLowerCase()}`;
  }

  onOpen(): void {
    this.titleEl.setText("Set up your personal knowledge base");
    const { contentEl } = this;
    contentEl.empty();
    const org = this.plugin.settings.baseOrg;

    if (!org) {
      contentEl.createEl("p", { text: "Choose a base organization first (Settings → Covault → GitHub)." });
      return;
    }

    contentEl.createEl("p", {
      text:
        `Connects this vault to a personal repo in ${org}. Everything stays private by default — ` +
        `only notes and folders you mark “Share to my knowledge base” are backed up there for the team.`,
    });

    // Mode tabs
    const tabs = contentEl.createDiv("covault-tabs");
    const tab = (label: string, mode: Mode) => {
      const btn = tabs.createEl("button", {
        text: label,
        cls: "covault-tab" + (this.mode === mode ? " is-active" : ""),
      });
      btn.onclick = () => {
        if (this.mode === mode) return;
        this.mode = mode;
        this.onOpen(); // full re-render; mode/name/selection live in fields
      };
    };
    tab("Use an existing repo", "existing");
    tab("Create a new repo", "create");

    this.bodyEl = contentEl.createDiv();
    this.renderBody();

    if (this.mode === "existing" && this.repos === null) void this.loadRepos();
    if (this.mode === "create" && this.nameState === "idle") void this.checkName();
  }

  onClose(): void {
    if (this.debounceId !== null) window.clearTimeout(this.debounceId);
    this.contentEl.empty();
  }

  private async loadRepos(): Promise<void> {
    const org = this.plugin.settings.baseOrg;
    const groups = await this.plugin.appAuth.listAccessibleRepos();
    const all = (groups.find((g) => g.login === org)?.repos ?? []).map((r) => r.split("/")[1] ?? r);
    // Personal KBs first — they're what this dialog is usually for.
    this.repos = [...all.filter((r) => r.startsWith("personal-kb-")), ...all.filter((r) => !r.startsWith("personal-kb-"))];
    if (!this.selected) this.selected = this.repos[0] ?? "";
    this.renderBody();
  }

  private scheduleNameCheck(): void {
    if (this.debounceId !== null) window.clearTimeout(this.debounceId);
    this.nameState = "checking";
    this.renderBody();
    this.debounceId = window.setTimeout(() => void this.checkName(), 450);
  }

  private async checkName(): Promise<void> {
    const org = this.plugin.settings.baseOrg;
    if (!this.name) {
      this.nameState = "idle";
      this.renderBody();
      return;
    }
    this.nameState = "checking";
    this.renderBody();
    try {
      if (!this.token) this.token = await this.plugin.appAuth.getRepoCreationToken(org);
      const taken = await repoExists(this.token, org, this.name);
      this.nameState = taken ? "taken" : "free";
    } catch {
      this.nameState = "unknown"; // offline etc — submit re-validates
    }
    this.renderBody();
  }

  private renderBody(): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    const org = this.plugin.settings.baseOrg;

    if (this.mode === "existing") {
      const setting = new Setting(this.bodyEl)
        .setName("Repository")
        .setDesc(this.repos === null ? `Loading repos in ${org}…` : `Repos you can access in ${org}.`);
      if (this.repos !== null) {
        if (this.repos.length === 0) {
          setting.setDesc(`No repos found in ${org} — create one instead.`);
        } else {
          setting.addDropdown((dd) => {
            for (const r of this.repos ?? []) dd.addOption(r, r);
            dd.setValue(this.selected).onChange((v) => (this.selected = v));
          });
        }
      }
      this.bodyEl.createEl("p", {
        cls: "setting-item-description",
        text:
          "Its contents will be pulled into this vault. Where a note exists on both sides, " +
          "the repo's version is used and yours is kept next to it as “(local copy)”.",
      });
      this.cta("Connect and pull", () => void this.submit("adopt"), this.repos !== null && this.repos.length > 0);
      return;
    }

    // Create mode
    new Setting(this.bodyEl)
      .setName("Repository name")
      .setDesc(`Created private in ${org} — convention: personal-kb-<you>.`)
      .addText((t) =>
        t.setValue(this.name).onChange((v) => {
          this.name = v.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
          this.scheduleNameCheck();
        }),
      );
    const status = this.bodyEl.createDiv({ cls: "setting-item-description" });
    switch (this.nameState) {
      case "checking":
        status.setText(`Checking ${org}/${this.name}…`);
        break;
      case "free":
        status.setText(`✨ ${org}/${this.name} is available — your marked notes will be its first commit.`);
        break;
      case "taken":
        status.setText(`⚠ ${org}/${this.name} already exists. Pick another name, or use the existing-repo tab.`);
        break;
      case "unknown":
        status.setText("Couldn't check the name — you can still continue.");
        break;
      default:
        status.setText("Enter a repository name.");
    }
    this.cta("Create and connect", () => void this.submit("create"), this.nameState !== "taken" && !!this.name);
  }

  private cta(label: string, onClick: () => void, enabled: boolean): void {
    new Setting(this.bodyEl).addButton((btn) => {
      btn.setButtonText(label).setCta().onClick(onClick);
      btn.setDisabled(!enabled || this.busy);
      this.ctaBtn = btn.buttonEl;
    });
  }

  private ctaBtn: HTMLButtonElement | null = null;

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
            throw new Error(`"${repoName}" already exists — pick another name or use the existing-repo tab.`);
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
      }

      await this.plugin.setupMainKb(`https://github.com/${org}/${repoName}.git`, "main", mode);
      new Notice(`Covault: your personal knowledge base is connected to ${org}/${repoName}.`);
      this.close();
    } catch (e) {
      new Notice(`Covault: setup failed — ${(e as Error).message}`, 10_000);
      this.busy = false;
      if (btn) {
        btn.disabled = false;
        btn.setText(idle);
      }
    }
  }
}

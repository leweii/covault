import { PluginSettingTab, Setting, type App } from "obsidian";
import type CovaultPlugin from "../main";
import { AddLibraryModal } from "./AddLibraryModal";
import { MainKbModal } from "./MainKbModal";
import { SharedItemsModal } from "./SharedItemsModal";

/**
 * Covault settings page.
 *
 * Layout: GitHub (sign-in method tabs + base org) → personal knowledge
 * base → shared libraries → AI engine → sync behavior. Users never see
 * git vocabulary anywhere in this UI.
 */
export class CovaultSettingTab extends PluginSettingTab {
  private onConnected = () => this.display();

  constructor(
    app: App,
    private plugin: CovaultPlugin,
  ) {
    super(app, plugin);
    // Re-render as soon as the browser deep-links back after Connect, so
    // the page flips to "Connected as @…" without a manual reopen. The
    // listener stays for the plugin's lifetime — display() on a hidden
    // tab is harmless, and removing it on hide() would miss a Connect
    // that completes while settings are closed.
    plugin.appAuth.addConnectedListener(this.onConnected);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderGitHubSection(containerEl);
    this.renderMainKbSection(containerEl);
    this.renderLibrariesSection(containerEl);
    this.renderAiSection(containerEl);
    this.renderSyncSection(containerEl);
  }

  // ── GitHub ───────────────────────────────────────────────────────
  private renderGitHubSection(el: HTMLElement): void {
    new Setting(el).setName("GitHub").setHeading();

    const s = this.plugin.settings;
    const card = el.createDiv("covault-card");

    // Segmented tabs — the two sign-in methods are alternatives, not
    // fields to fill side by side.
    const tabs = card.createDiv("covault-tabs");
    const tab = (label: string, method: typeof s.authMethod) => {
      const btn = tabs.createEl("button", {
        text: label,
        cls: "covault-tab" + (s.authMethod === method ? " is-active" : ""),
      });
      btn.onclick = () => {
        if (s.authMethod === method) return;
        s.authMethod = method;
        void this.plugin.saveSettings();
        this.display();
      };
    };
    tab("GitHub App", "githubApp");
    tab("Personal Access Token", "pat");

    if (s.authMethod === "pat") {
      new Setting(card)
        .setName("Personal access token")
        .setDesc("Advanced: a GitHub PAT with repo access. Most users should sign in with the GitHub App instead.")
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("ghp_… or github_pat_…")
            .setValue(s.githubToken)
            .onChange(async (value) => {
              s.githubToken = value.trim();
              await this.plugin.saveSettings();
            });
        });
      this.renderIdentityRows(card);
      return;
    }

    const connections = s.githubApp.connections;
    if (connections.length === 0) {
      new Setting(card)
        .setName("Connect to GitHub")
        .setDesc("Authorize Covault in your browser — one click, no tokens to copy.")
        .addButton((btn) =>
          btn
            .setButtonText("Connect")
            .setCta()
            .onClick(() => void this.plugin.appAuth.beginConnect()),
        );
      return;
    }

    for (const conn of connections) {
      const orgs = conn.installations.map((i) => i.accountLogin).join(", ");
      new Setting(card)
        .setName(`✓ @${conn.login}`)
        .setDesc(orgs ? `Access to: ${orgs}` : "No installations yet — install the app on your org.")
        .addExtraButton((btn) =>
          btn
            .setIcon("refresh-cw")
            .setTooltip("Refresh organizations")
            .onClick(async () => {
              await this.plugin.appAuth.refreshInstallations(conn.login);
              this.display();
            }),
        )
        .addButton((btn) =>
          btn
            .setButtonText("Disconnect")
            .setWarning()
            .onClick(async () => {
              await this.plugin.appAuth.disconnect(conn.login);
              this.display();
            }),
        );
    }

    // Base org: the one organization every knowledge repo lives in —
    // shared libraries and personal KBs are grouped under it.
    const orgOptions = [...new Set(connections.flatMap((c) => c.installations.map((i) => i.accountLogin)))];
    if (orgOptions.length > 0) {
      if (!s.baseOrg && orgOptions.length === 1) {
        s.baseOrg = orgOptions[0] ?? "";
        void this.plugin.saveSettings();
      }
      new Setting(card)
        .setName("Knowledge base organization")
        .setDesc("Shared libraries and personal knowledge bases all live in this organization.")
        .addDropdown((dd) => {
          dd.addOption("", "— choose —");
          for (const o of orgOptions) dd.addOption(o, o);
          dd.setValue(s.baseOrg).onChange(async (v) => {
            s.baseOrg = v;
            await this.plugin.saveSettings();
          });
        });
    }

    this.renderIdentityRows(card);
  }

  /** Commit identity ("who saved this note"), shown under either tab. */
  private renderIdentityRows(card: HTMLElement): void {
    const s = this.plugin.settings;
    const login = s.githubApp.connections[0]?.login;

    new Setting(card).setName("Name").addText((t) =>
      t
        .setPlaceholder(login ?? "Your name")
        .setValue(s.author.name)
        .onChange(async (v) => {
          s.author.name = v.trim();
          await this.plugin.saveSettings();
        }),
    );

    new Setting(card).setName("Email").addText((t) =>
      t
        .setPlaceholder(login ? `${login}@users.noreply.github.com` : "you@example.com")
        .setValue(s.author.email)
        .onChange(async (v) => {
          s.author.email = v.trim();
          await this.plugin.saveSettings();
        }),
    );
  }

  // ── Personal knowledge base ──────────────────────────────────────
  private renderMainKbSection(el: HTMLElement): void {
    new Setting(el).setName("Personal knowledge base").setHeading();

    const s = this.plugin.settings;

    if (s.mainRepo) {
      new Setting(el)
        .setName("Connected")
        .setDesc(`${s.mainRepo.url.replace(/\.git$/, "")} (${s.mainRepo.branch})`)
        .addButton((btn) =>
          btn
            .setButtonText("Disconnect")
            .setWarning()
            .onClick(async () => {
              // Local notes and history stay; only the link is removed.
              s.mainRepo = null;
              await this.plugin.saveSettings();
              this.display();
            }),
        );

      const shared = this.plugin.libraryManifest.load().include;
      if (shared.length === 0) {
        new Setting(el)
          .setName("Nothing shared yet")
          .setDesc(
            "Your vault is private by default. Right-click a note or folder and choose " +
              "“Share to my knowledge base” to start backing it up.",
          );
      } else {
        new Setting(el)
          .setName(`${shared.length} item(s) shared`)
          .setDesc("Only marked notes and folders sync to your personal repo.")
          .addButton((btn) =>
            btn.setButtonText("Manage…").onClick(() => new SharedItemsModal(this.app, this.plugin).open()),
          );
      }
      return;
    }

    new Setting(el)
      .setName("Back up this vault")
      .setDesc(
        "Connect your own repo (personal-kb-<you>) in your team's organization. " +
          "Nothing is shared until you mark it — right-click a note or folder → “Share to my knowledge base”.",
      )
      .addButton((btn) =>
        btn
          .setButtonText("Set up…")
          .setCta()
          .onClick(() => new MainKbModal(this.app, this.plugin).open()),
      );
  }

  // ── Shared libraries ─────────────────────────────────────────────
  private renderLibrariesSection(el: HTMLElement): void {
    new Setting(el).setName("Shared libraries").setHeading();

    for (const repo of this.plugin.libraryManifest.load().repos) {
      new Setting(el)
        .setName(repo.path)
        .setDesc(`${repo.url} (${repo.branch})`)
        .addButton((btn) =>
          btn
            .setButtonText("Remove")
            .setWarning()
            .onClick(() => {
              // The folder stays on disk — removing only stops syncing it.
              this.plugin.libraryManifest.remove(repo.path);
              this.display();
            }),
        );
    }

    new Setting(el)
      .setName("Add a library")
      .setDesc("Pick one of your team's libraries, or create a new one.")
      .addButton((btn) =>
        btn
          .setButtonText("Add…")
          .setCta()
          .onClick(() => new AddLibraryModal(this.app, this.plugin).open()),
      );
  }

  // ── AI engine ────────────────────────────────────────────────────
  private renderAiSection(el: HTMLElement): void {
    new Setting(el).setName("AI engine").setHeading();

    const s = this.plugin.settings;
    const providers = this.plugin.models.getProviders();

    new Setting(el)
      .setName("Provider")
      .setDesc("Who serves the model that powers syncing, summaries, and conflict handling.")
      .addDropdown((dd) => {
        for (const p of providers) dd.addOption(p.id, p.name);
        if (!providers.some((p) => p.id === s.llm.provider) && providers[0]) {
          s.llm.provider = providers[0].id;
        }
        dd.setValue(s.llm.provider).onChange(async (value) => {
          s.llm.provider = value;
          s.llm.model = "";
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(el)
      .setName("API key")
      .setDesc(`Stored on this device only — never inside your vault.`)
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-…")
          .setValue(s.llmKeys[s.llm.provider] ?? "")
          .onChange(async (value) => {
            const key = value.trim();
            if (key) s.llmKeys[s.llm.provider] = key;
            else delete s.llmKeys[s.llm.provider];
            await this.plugin.saveSettings();
          });
      });

    new Setting(el)
      .setName("Conflict merge instructions")
      .setDesc(
        "Optional extra rules for the AI when it merges conflicting edits — e.g. " +
          "“when versions disagree about facts, never guess: mark it unresolvable and let me decide.”",
      )
      .addTextArea((ta) => {
        ta.inputEl.rows = 3;
        ta.setPlaceholder("Your team's rules…")
          .setValue(s.llm.conflictInstructions)
          .onChange(async (v) => {
            s.llm.conflictInstructions = v;
            await this.plugin.saveSettings();
          });
      });

    const models = this.plugin.models.getModels(s.llm.provider);
    new Setting(el).setName("Model").addDropdown((dd) => {
      for (const m of models) dd.addOption(m.id, m.name ?? m.id);
      if (!models.some((m) => m.id === s.llm.model) && models[0]) {
        s.llm.model = models[0].id;
      }
      dd.setValue(s.llm.model).onChange(async (value) => {
        s.llm.model = value;
        await this.plugin.saveSettings();
      });
    });
  }

  // ── Sync ─────────────────────────────────────────────────────────
  private renderSyncSection(el: HTMLElement): void {
    new Setting(el).setName("Sync").setHeading();

    const s = this.plugin.settings;

    new Setting(el)
      .setName("Keep shared knowledge up to date automatically")
      .setDesc("Covault quietly checks for updates and shares your changes in the background.")
      .addToggle((toggle) =>
        toggle.setValue(s.sync.auto).onChange(async (value) => {
          s.sync.auto = value;
          await this.plugin.saveSettings();
          this.plugin.applySyncSchedule();
        }),
      );

    new Setting(el).setName("Check every").addDropdown((dd) => {
      for (const min of [5, 10, 15, 30, 60]) dd.addOption(String(min), `${min} minutes`);
      dd.setValue(String(s.sync.intervalMinutes)).onChange(async (value) => {
        s.sync.intervalMinutes = Number(value);
        await this.plugin.saveSettings();
        this.plugin.applySyncSchedule();
      });
    });
  }
}

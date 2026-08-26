import {
  Notice,
  PluginSettingTab,
  type App,
  type Setting,
  type SettingDefinition,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
  type SettingDefinitionList,
  type SettingGroupItem,
} from "obsidian";
import { installUrl } from "../auth/constants";
import { CUSTOM_PROVIDER_ID } from "../llm/models";
import type CovaultPlugin from "../main";
import { AddLibraryModal } from "./AddLibraryModal";
import { MainKbModal } from "./MainKbModal";
import { SharedItemsModal } from "./SharedItemsModal";
import { ImportConfigModal } from "./ImportConfigModal";

/**
 * Covault settings, declarative (Obsidian 1.13+): definitions feed the
 * settings search index, and control values persist through the
 * overridden getControlValue/setControlValue — which route through the
 * plugin's redacting saveSettings() so secrets never reach data.json.
 *
 * Layout: GitHub (sign-in tabs + base org + identity) → personal
 * knowledge base → shared libraries → AI engine → sync behavior. Users
 * never see git vocabulary anywhere in this UI.
 */
export class CovaultSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: CovaultPlugin,
  ) {
    super(app, plugin);
    // Rebuild as soon as the browser deep-links back after Connect, so
    // the page flips to "Connected as @…" without a manual reopen.
    plugin.appAuth.addConnectedListener(() => this.update());
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    // Scoping hook for this tab's CSS. A declarative tab never gets
    // display() called, and this runs on every render — so it is the one
    // reliable place to mark the container.
    this.containerEl.addClass("covault-settings");
    return [
      this.configTransfer(),
      this.githubGroup(),
      this.personalKbGroup(),
      this.librariesList(),
      this.aiGroup(),
      this.syncGroup(),
    ];
  }

  // ── Value plumbing ───────────────────────────────────────────────
  // All keys route through the plugin's saveSettings(): it writes
  // secrets to the per-device store and only redacted state to data.json.

  getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    switch (key) {
      case "mainKbScope":
        return this.plugin.mainKbScope();
      case "baseOrg":
        return s.baseOrg;
      case "authorName":
        return s.author.name;
      case "authorEmail":
        return s.author.email;
      case "llmProvider":
        return s.llm.provider;
      case "llmModel":
        return s.llm.model;
      case "customBaseUrl":
        return s.customLlm.baseUrl;
      case "customModel":
        return s.customLlm.model;
      case "customVision":
        return s.customLlm.vision;
      case "announceAgents":
        return s.announceToAgents;
      case "askApprove":
        return s.ask.requireApproval;
      case "askMcp":
        return s.ask.mcpServers;
      case "syncAuto":
        return s.sync.auto;
      case "syncInterval":
        return String(s.sync.intervalMinutes);
      case "debugMode":
        return s.debugMode;
      default:
        return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    switch (key) {
      // Scope lives in the manifest (it travels with the vault), not in
      // settings — it persists and re-renders on its own.
      case "mainKbScope":
        await this.plugin.setMainKbScope(value === "vault" ? "vault" : "marked");
        return;
      case "baseOrg":
        s.baseOrg = String(value);
        break;
      case "authorName":
        s.author.name = String(value).trim();
        break;
      case "authorEmail":
        s.author.email = String(value).trim();
        break;
      case "llmProvider":
        s.llm.provider = String(value);
        s.llm.model = "";
        break;
      case "llmModel":
        s.llm.model = String(value);
        break;
      case "customBaseUrl":
        s.customLlm.baseUrl = String(value).trim().replace(/\/+$/, "");
        break;
      case "customModel":
        s.customLlm.model = String(value).trim();
        break;
      case "customVision":
        s.customLlm.vision = Boolean(value);
        break;
      case "announceAgents":
        // Owns its own persistence: writes/removes the adapter files too.
        await this.plugin.setAnnounceToAgents(Boolean(value));
        return;
      case "askApprove":
        s.ask.requireApproval = Boolean(value);
        break;
      case "askMcp":
        s.ask.mcpServers = String(value);
        // Drop cached connections: the entry just edited may be the broken one.
        this.plugin.mcp.reset();
        break;
      case "syncAuto":
        s.sync.auto = Boolean(value);
        break;
      case "syncInterval":
        s.sync.intervalMinutes = Number(value);
        break;
      case "debugMode":
        s.debugMode = Boolean(value);
        // Stamp the header first, so the log opens with the environment
        // it was collected on rather than a bare first event.
        if (s.debugMode) this.plugin.logDebugHeader();
        break;
      default:
        return;
    }
    if (key.startsWith("custom")) {
      // Rebuild the provider before saving: the selected model id is
      // derived from these fields.
      this.plugin.refreshCustomProvider();
    }
    await this.plugin.saveSettings();
    if (key === "syncAuto" || key === "syncInterval") this.plugin.applySyncSchedule();
    // The provider choice changes which model options exist, and the
    // custom fields change whether they are shown at all.
    if (key === "llmProvider" || key.startsWith("custom")) this.update();
  }

  /** Ungrouped, above everything: moving a setup between machines is the
   *  first thing you reach for, not a footnote under Sync. */
  private configTransfer(): SettingDefinition {
    return {
      name: "Export / import configuration",
      aliases: ["backup", "export", "import", "share settings"],
      render: (setting: Setting) => {
        setting.addButton((btn) =>
          btn.setButtonText("Copy to clipboard").onClick(() => void this.plugin.exportConfiguration()),
        );
        setting.addButton((btn) =>
          btn.setButtonText("Import…").onClick(() => new ImportConfigModal(this.app, this.plugin).open()),
        );
      },
    };
  }

  // ── GitHub ───────────────────────────────────────────────────────
  private githubGroup(): SettingDefinitionGroup {
    const s = this.plugin.settings;
    const connections = s.githubApp.connections;
    const orgOptions = [...new Set(connections.flatMap((c) => c.installations.map((i) => i.accountLogin)))];
    if (!s.baseOrg && orgOptions.length === 1) {
      s.baseOrg = orgOptions[0] ?? "";
      void this.plugin.saveSettings();
    }
    const login = connections[0]?.login;
    const hasInstallations = orgOptions.length > 0;

    const items: SettingGroupItem[] = [
      {
        name: "Sign in with",
        aliases: ["github app", "personal access token", "pat", "connect"],
        render: (setting: Setting) => this.renderAuthTabs(setting),
      },
      {
        name: "Covault GitHub App",
        desc: hasInstallations
          ? "Add Covault to another organization, or change which repositories it can reach."
          : "Covault reaches your team's knowledge through a GitHub App. Install it on your " +
            "organization first — an owner may have to approve it — then connect below.",
        aliases: ["install", "github app", "organization", "permissions", "approve"],
        visible: () => this.plugin.settings.authMethod === "githubApp",
        render: (setting: Setting) => {
          setting.addButton((btn) =>
            btn
              .setButtonText(hasInstallations ? "Configure on GitHub" : "Install on GitHub")
              .setTooltip(installUrl())
              .onClick(() => {
                window.open(installUrl(), "_blank");
              }),
          );
        },
      },
      {
        name: "Personal access token",
        desc: "Advanced: a GitHub PAT with repo access. Most users should sign in with the GitHub App instead.",
        visible: () => this.plugin.settings.authMethod === "pat",
        render: (setting: Setting) =>
          setting.addText((t) => {
            t.inputEl.type = "password";
            t.setPlaceholder("ghp_… or github_pat_…")
              .setValue(this.plugin.settings.githubToken)
              .onChange(async (v) => {
                this.plugin.settings.githubToken = v.trim();
                await this.plugin.saveSettings();
                // PAT mode never runs the Connect flow, so this is the
                // one point where a user-scoped token becomes available.
                if (this.plugin.settings.githubToken) await this.plugin.refreshAuthorFromGitHub();
              });
          }),
      },
      {
        name: "Connect to GitHub",
        desc: "Authorize Covault in your browser — one click, no tokens to copy.",
        visible: () => this.plugin.settings.authMethod === "githubApp" && connections.length === 0,
        render: (setting: Setting) =>
          setting.addButton((btn) =>
            btn
              .setButtonText("Connect")
              .setCta()
              .onClick(() => void this.plugin.appAuth.beginConnect()),
          ),
      },
      ...connections.map((conn) => {
        const orgs = conn.installations.map((i) => i.accountLogin).join(", ");
        return {
          name: `Connected as @${conn.login}`,
          desc: orgs ? `Access to: ${orgs}` : "No installations yet — install the app on your org.",
          visible: () => this.plugin.settings.authMethod === "githubApp",
          render: (setting: Setting) => {
            setting.addExtraButton((btn) =>
              btn
                .setIcon("refresh-cw")
                .setTooltip("Refresh organizations")
                .onClick(async () => {
                  await this.plugin.appAuth.refreshInstallations(conn.login);
                  this.update();
                }),
            );
            setting.addButton((btn) =>
              btn
                .setButtonText("Disconnect")
                .setWarning()
                .onClick(async () => {
                  await this.plugin.appAuth.disconnect(conn.login);
                  this.update();
                }),
            );
          },
        };
      }),
      {
        name: "Knowledge base organization",
        desc: "Shared libraries and personal knowledge bases all live in this organization.",
        visible: () => this.plugin.settings.authMethod === "githubApp" && orgOptions.length > 0,
        control: {
          type: "dropdown",
          key: "baseOrg",
          options: Object.fromEntries([["", "— choose —"], ...orgOptions.map((o) => [o, o])]),
        },
      },
      {
        name: "Name",
        desc: "Shown to teammates as the author of your changes.",
        control: { type: "text", key: "authorName", placeholder: login ?? "Your name" },
      },
      {
        name: "Email",
        control: {
          type: "text",
          key: "authorEmail",
          placeholder: login ? `${login}@users.noreply.github.com` : "you@example.com",
        },
      },
    ];

    return { type: "group", heading: "GitHub", items };
  }

  /** Segmented control for the two mutually-exclusive sign-in methods. */
  /**
   * Live status per configured MCP server. "Test" connects for real —
   * which is also what starts the browser sign-in for an OAuth server, so
   * the user has a way to authorize without first asking a question.
   */
  private renderMcpStatus(setting: Setting): void {
    const box = setting.controlEl.createDiv("covault-mcp-status");
    const paint = () => {
      box.empty();
      const rows = this.plugin.mcp.status();
      if (rows.length === 0) {
        box.createSpan({ cls: "covault-mcp-none", text: "No services configured." });
        return;
      }
      for (const row of rows) {
        const line = box.createDiv("covault-mcp-row");
        const state = row.ok ? "is-ok" : row.needsAuth ? "is-auth" : "is-bad";
        line.createSpan({ cls: `covault-mcp-dot ${state}` });
        line.createSpan({ cls: "covault-mcp-name", text: row.name });
        line.createSpan({
          cls: "covault-mcp-detail",
          text: row.ok ? `${row.toolCount} tool${row.toolCount === 1 ? "" : "s"}` : (row.error ?? "unavailable"),
        });
        // Sign-in is per server and only ever on an explicit click.
        if (row.needsAuth) {
          const btn = line.createEl("button", { cls: "covault-mcp-signin", text: "Sign in" });
          btn.onclick = async () => {
            btn.setAttribute("disabled", "true");
            btn.setText("Signing in…");
            try {
              await this.plugin.mcp.signIn(row.name);
              new Notice(`Covault: connected to "${row.name}".`);
            } catch (e) {
              new Notice(`Covault: couldn't connect to "${row.name}" — ${(e as Error).message}`, 10_000);
            } finally {
              paint();
            }
          };
        }
      }
    };
    paint();
    setting.addButton((btn) =>
      btn
        .setButtonText("Check")
        .setTooltip("Connect to each service without signing in")
        .onClick(async () => {
          btn.setDisabled(true).setButtonText("Checking…");
          this.plugin.mcp.reset();
          try {
            await this.plugin.mcp.tools();
          } finally {
            paint();
            btn.setDisabled(false).setButtonText("Check");
          }
        }),
    );
  }

  private renderAuthTabs(setting: Setting): void {
    const s = this.plugin.settings;
    const tabs = setting.controlEl.createDiv("covault-tabs");
    const tab = (label: string, method: typeof s.authMethod) => {
      const btn = tabs.createEl("button", {
        text: label,
        cls: "covault-tab" + (s.authMethod === method ? " is-active" : ""),
      });
      btn.onclick = () => {
        if (s.authMethod === method) return;
        s.authMethod = method;
        void this.plugin.saveSettings();
        this.update();
      };
    };
    tab("GitHub App", "githubApp");
    tab("Personal Access Token", "pat");
  }

  // ── Personal knowledge base ──────────────────────────────────────
  private personalKbGroup(): SettingDefinitionGroup {
    const s = this.plugin.settings;
    const items: SettingGroupItem[] = [];

    if (s.mainRepo) {
      const repo = s.mainRepo;
      items.push({
        name: "Connected",
        desc: `${repo.url.replace(/\.git$/, "")} (${repo.branch})`,
        render: (setting: Setting) => {
          setting.addButton((btn) =>
            btn
              .setButtonText("Disconnect")
              .setWarning()
              .onClick(async () => {
                // Local notes and history stay; only the link is removed.
                this.plugin.settings.mainRepo = null;
                await this.plugin.saveSettings();
                this.update();
              }),
          );
        },
      });
      items.push(this.scopeItem());

      const shared = this.plugin.libraryManifest.load().include;
      if (this.plugin.mainKbScope() === "marked") {
        items.push(
          shared.length === 0
            ? {
                name: "Nothing shared yet",
                desc:
                  "Your vault is private by default. Right-click a note or folder and choose " +
                  "“Share to my knowledge base” to start backing it up.",
              }
            : {
                name: `${shared.length} item(s) shared`,
                desc: "Only marked notes and folders sync to your personal repo.",
                aliases: ["shared items", "stop sharing"],
                render: (setting: Setting) => {
                  setting.addButton((btn) =>
                    btn.setButtonText("Manage…").onClick(() => new SharedItemsModal(this.app, this.plugin).open()),
                  );
                },
              },
        );
      }
    } else {
      items.push({
        name: "Back up this vault",
        desc:
          "Connect your own repo (personal-kb-<you>) in your team's organization. " +
          "Nothing is shared until you mark it — right-click a note or folder → “Share to my knowledge base”.",
        aliases: ["personal repo", "backup"],
        render: (setting: Setting) => {
          setting.addButton((btn) =>
            btn
              .setButtonText("Set up…")
              .setCta()
              .onClick(() => new MainKbModal(this.app, this.plugin).open()),
          );
        },
      });
    }

    return { type: "group", heading: "Personal knowledge base", items };
  }

  /** Opt-in vs whole-vault. Team libraries are left out either way — they
   *  are knowledge bases in their own right, and a note living in two of
   *  them would be pushed twice and end up conflicting with itself. */
  private scopeItem(): SettingGroupItem {
    const libs = this.plugin.libraryManifest.load().repos.length;
    const vaultDesc =
      libs === 0
        ? "Every note in this vault is backed up. Team libraries you add later stay out of it automatically."
        : `Every note in this vault is backed up, except your ${libs} team ` +
          `${libs === 1 ? "library" : "libraries"} — those sync to their own repos.`;
    return {
      name: "What to back up",
      desc: this.plugin.mainKbScope() === "vault" ? vaultDesc : "Nothing leaves this device until you mark it.",
      aliases: ["scope", "everything", "whole vault", "opt-in", "privacy"],
      control: {
        type: "dropdown",
        key: "mainKbScope",
        options: { marked: "Only notes I mark", vault: "Everything in this vault" },
      },
    };
  }

  // ── Shared libraries ─────────────────────────────────────────────
  private librariesList(): SettingDefinitionList {
    const repos = this.plugin.libraryManifest.load().repos;
    return {
      type: "list",
      heading: "Shared libraries",
      emptyState: "No libraries yet — add one to pull your team's knowledge in.",
      items: repos.map((repo) => ({
        name: repo.path,
        desc: `${repo.url} (${repo.branch})`,
      })),
      onDelete: (index: number) => {
        const repo = repos[index];
        if (!repo) return;
        // The folder and its notes stay on disk — only the link goes.
        this.plugin.removeLibrary(repo.path);
        this.update();
      },
      addItem: {
        name: "Add a library…",
        action: () => new AddLibraryModal(this.app, this.plugin).open(),
      },
    };
  }

  // ── AI engine ────────────────────────────────────────────────────
  private aiGroup(): SettingDefinitionGroup {
    const s = this.plugin.settings;
    const providers = this.plugin.models.getProviders();
    if (!providers.some((p) => p.id === s.llm.provider) && providers[0]) {
      s.llm.provider = providers[0].id;
    }
    const models = this.plugin.models.getModels(s.llm.provider);
    if (!models.some((m) => m.id === s.llm.model) && models[0]) {
      s.llm.model = models[0].id;
    }

    return {
      type: "group",
      heading: "AI engine",
      items: [
        {
          name: "Provider",
          desc: "Who serves the model that powers syncing, summaries, and conflict handling.",
          control: {
            type: "dropdown",
            key: "llmProvider",
            options: Object.fromEntries(providers.map((p) => [p.id, p.name])),
          },
        },
        {
          name: "API key",
          desc: "Stored on this device only — never inside your vault.",
          render: (setting: Setting) => {
            setting.addText((t) => {
              t.inputEl.type = "password";
              t.setPlaceholder("sk-…")
                .setValue(this.plugin.settings.llmKeys[this.plugin.settings.llm.provider] ?? "")
                .onChange(async (v) => {
                  const key = v.trim();
                  const current = this.plugin.settings.llm.provider;
                  if (key) this.plugin.settings.llmKeys[current] = key;
                  else delete this.plugin.settings.llmKeys[current];
                  await this.plugin.saveSettings();
                });
            });
          },
        },
        {
          name: "Model",
          visible: () => this.plugin.settings.llm.provider !== CUSTOM_PROVIDER_ID,
          control: {
            type: "dropdown",
            key: "llmModel",
            options: Object.fromEntries(models.map((m) => [m.id, m.name ?? m.id])),
          },
        },
        {
          name: "Endpoint",
          aliases: ["custom", "base url", "openai compatible", "local", "ollama", "lm studio", "gateway"],
          visible: () => this.plugin.settings.llm.provider === CUSTOM_PROVIDER_ID,
          control: { type: "text", key: "customBaseUrl", placeholder: "https://openrouter.ai/api/v1" },
        },
        {
          name: "Model name",
          aliases: ["custom model", "model id"],
          visible: () => this.plugin.settings.llm.provider === CUSTOM_PROVIDER_ID,
          control: { type: "text", key: "customModel", placeholder: "deepseek/deepseek-v4-flash-vision-exp" },
        },
        {
          name: "This model can read images",
          aliases: ["vision", "images", "screenshots"],
          visible: () => this.plugin.settings.llm.provider === CUSTOM_PROVIDER_ID,
          control: { type: "toggle", key: "customVision" },
        },
        {
          name: "Connected services (MCP)",
          aliases: ["mcp", "model context protocol", "servers", "tools"],
          // The shape hint lives in the placeholder now rather than in a
          // paragraph of description — visible exactly when it's needed.
          control: {
            type: "textarea",
            key: "askMcp",
            placeholder: '{"mcpServers": {"name": {"url": "https://…"}}}',
          },
        },
        {
          name: "Service status",
          aliases: ["mcp status", "check connection", "sign in", "authorize", "oauth"],
          render: (setting: Setting) => this.renderMcpStatus(setting),
        },
        {
          name: "Let AI assistants discover your libraries",
          aliases: ["agents.md", "claude.md", "skill", "announce"],
          control: { type: "toggle", key: "announceAgents" },
        },
        {
          name: "Ask before the agent acts",
          aliases: ["approve", "permissions", "skip permissions", "dangerous", "shell", "cli"],
          control: { type: "toggle", key: "askApprove" },
        },
      ],
    };
  }

  // ── Sync ─────────────────────────────────────────────────────────
  private syncGroup(): SettingDefinitionGroup {
    return {
      type: "group",
      heading: "Sync",
      items: [
        {
          name: "Keep shared knowledge up to date automatically",
          control: { type: "toggle", key: "syncAuto" },
        },
        {
          name: "Check every",
          control: {
            type: "dropdown",
            key: "syncInterval",
            options: Object.fromEntries([5, 10, 15, 30, 60].map((min) => [String(min), `${min} minutes`])),
          },
        },
        {
          name: "Verbose diagnostics",
          control: { type: "toggle", key: "debugMode" },
        },
      ],
    };
  }
}

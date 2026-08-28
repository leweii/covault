import { apiVersion, FileSystemAdapter, Notice, Plugin, TFile, TFolder } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import type { MutableModels } from "@earendil-works/pi-ai";
import { DEFAULT_SETTINGS, isSignedIn, type CovaultSettings } from "./settings";
import { GitEngine } from "./git/GitEngine";
import { createNodeHttp } from "./git/nodeHttp";
import { DebugLog } from "./debug/logger";
import { SyncController, type RepoState, type SyncItem } from "./sync/SyncController";
import { AppAuth } from "./auth/AppAuth";
import { PROTOCOL_ACTION } from "./auth/constants";
import { ManifestStore, type MainKbScope, type ManifestRepo } from "./covault/manifest";
import { ensureIgnored } from "./covault/gitignore";
import { ownerKeyForPath } from "./covault/ownership";
import { sameRemote } from "./git/urls";
import { FolderLinkedError } from "./covault/errors";
import { writeKnowledgeSkill, SKILL_RELPATH } from "./covault/skill";
import { removeAdapters, writeAdapters } from "./covault/adapters";
import { gatherFacts } from "./covault/skill";
import { buildConfigExport, type ImportPlan } from "./covault/exportConfig";
import { LibraryDescriber } from "./llm/describe";
import { AddLibraryModal } from "./ui/AddLibraryModal";
import { ShareFolderModal } from "./ui/ShareFolderModal";
import { ConflictModal, type ConflictOps } from "./ui/ConflictModal";
import { FileHistoryModal } from "./ui/FileHistoryModal";
import { CovaultPanel, COVAULT_VIEW_TYPE } from "./ui/CovaultPanel";
import { AskView, COVAULT_ASK_VIEW_TYPE } from "./ui/AskView";
import { AskEngine } from "./llm/ask";
import { describeEndpoint } from "./llm/reachability";
import { makeReadTool, makeRunCommandTool, makeSearchTool, type AskTool } from "./llm/agentTools";
import { makeEditTools } from "./llm/editTools";
import { McpManager } from "./llm/mcp";
import { CliInventory } from "./llm/cliInventory";
import { ConflictResolver } from "./llm/resolver";
import { createOrgRepo, fetchUserIdentity, noreplyEmail, type GitHubIdentity } from "./git/githubApi";
import type { RepoRef } from "./git/GitEngine";
import {
  appConfigDir,
  applySecrets,
  clearSecrets,
  extractSecrets,
  readSecrets,
  redactSecrets,
  settingsHaveInlineSecrets,
  vaultKey,
  writeSecrets,
} from "./config/secretStore";
import { buildModels, customProvider, CUSTOM_PROVIDER_ID } from "./llm/models";
import { CovaultSettingTab } from "./ui/SettingsTab";

export default class CovaultPlugin extends Plugin {
  settings: CovaultSettings = structuredClone(DEFAULT_SETTINGS);
  models!: MutableModels;
  engine!: GitEngine;
  sync!: SyncController;
  appAuth!: AppAuth;
  libraryManifest!: ManifestStore;
  resolver!: ConflictResolver;
  describer!: LibraryDescriber;
  mcp!: McpManager;
  cliInventory!: CliInventory;
  debugLog!: DebugLog;
  private settingsTab: CovaultSettingTab | null = null;
  private statusBarEl!: HTMLElement;
  private syncIntervalId: number | null = null;
  /** Libraries mid-removal. Disabling the panel's button isn't enough: any
   *  sync tick re-renders the panel with a fresh, enabled button, and a
   *  removal can spend minutes awaiting an in-flight round. */
  private removingLibraries = new Set<string>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.models = buildModels({
      getKey: (providerId) => this.settings.llmKeys[providerId],
      setKey: async (providerId, key) => {
        if (key) this.settings.llmKeys[providerId] = key;
        else delete this.settings.llmKeys[providerId];
        await this.saveSettings();
      },
      listKeyedProviders: () => Object.keys(this.settings.llmKeys),
    });
    this.refreshCustomProvider();

    // The plugin itself is the host: AppAuth reads settings through the
    // live reference, so a future loadSettings() swap stays visible.
    this.appAuth = new AppAuth(this);
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
      void this.appAuth.handleCallback(params);
    });
    // Signing in is the one moment the identity is knowable without asking.
    this.appAuth.addConnectedListener(() => void this.refreshAuthorFromGitHub());

    // Built before the engine: it wraps the http client, and reads the
    // setting live so toggling debug mode takes effect without a reload.
    this.debugLog = new DebugLog({
      fs,
      enabled: () => this.settings.debugMode,
      // Outside the vault, deliberately. This vault may be synced (iCloud,
      // Dropbox, Obsidian Sync), and a log inside it becomes one file that
      // several machines append to — which is how a machine that was never
      // signed in filled this one's log with its own failures. Diagnostics
      // are per-device; keyed by vault so two vaults here stay apart.
      logDir: () => path.join(appConfigDir(), "logs", vaultKey(this.vaultBasePath())),
    });

    // AppAuth delegates per-call: GitHub App when connected, PAT otherwise.
    this.engine = new GitEngine({
      fs,
      http: createNodeHttp(this.debugLog),
      tokens: this.appAuth,
      author: () => this.gitAuthor(),
      configDir: () => this.app.vault.configDir,
      log: this.debugLog,
    });
    this.libraryManifest = new ManifestStore(this.vaultBasePath());
    await this.migrateReposToManifest();
    // After the manifest: the header reports how many libraries are set up.
    // Always: the operations log runs unconditionally, so every log file
    // opens with the environment it was collected on.
    this.logDebugHeader();

    this.resolver = new ConflictResolver({
      models: this.models,
      getSelection: () => this.settings.llm,
      hasKey: (provider) => this.hasModelAccess(provider),
      onTransport: (line, failed) => (failed ? this.debugLog.op("llm", line) : this.debugLog.log("llm", line)),
      diagnose: describeEndpoint,
    });

    // Probed lazily on the first question, then cached: the agent is told
    // which CLIs this machine has, and run_command inherits the same PATH.
    this.cliInventory = new CliInventory({
      cwd: () => this.vaultBasePath(),
      declared: () => this.settings.ask.cliHints,
    });
    // Built after the inventory: an MCP server started as a command needs
    // the same real PATH, or `npx` is not found.
    this.mcp = new McpManager(
      () => this.settings.ask.mcpServers,
      () => this.cliInventory.env(),
      (url) => window.open(url, "_blank"),
    );
    this.describer = new LibraryDescriber({
      models: this.models,
      getSelection: () => this.settings.llm,
      hasKey: (provider) => this.hasModelAccess(provider),
      onTransport: (line, failed) => (failed ? this.debugLog.op("llm", line) : this.debugLog.log("llm", line)),
      diagnose: describeEndpoint,
    });

    this.sync = new SyncController(
      this.engine,
      {
        vaultBasePath: () => this.vaultBasePath(),
        repos: () => this.syncItems(),
        onStateChange: (states) => {
          this.renderStatusBar(states);
          this.refreshPanels();
        },
        // Libraries may have pulled new content — keep the routing skill
        // describing what is actually on disk.
        onSyncPass: () => this.refreshKnowledgeSkill(),
      },
      this.resolver,
      this.debugLog,
    );

    // Registered last: addSettingTab() immediately asks the tab for its
    // setting definitions (Obsidian 1.13 search indexing), and those read
    // the manifest, models and sync state built above.
    this.settingsTab = new CovaultSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    this.registerView(COVAULT_VIEW_TYPE, (leaf) => new CovaultPanel(leaf, this));
    this.registerView(COVAULT_ASK_VIEW_TYPE, (leaf) => new AskView(leaf, this));
    this.addRibbonIcon("library", "Open Covault panel", () => void this.activatePanel());
    this.addCommand({
      id: "open-panel",
      name: "Open panel",
      callback: () => void this.activatePanel(),
    });
    this.app.workspace.onLayoutReady(() => {
      // Open the panel in the right sidebar on first install; afterwards
      // respect whatever the user did with it (Obsidian restores layout).
      if (this.app.workspace.getLeavesOfType(COVAULT_VIEW_TYPE).length === 0) {
        void this.activatePanel(false);
      }
    });

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("mod-clickable");
    this.statusBarEl.onClickEvent(() => {
      if (this.sync.pendingConflicts().length > 0) this.openConflictModal();
      else void this.sync.syncAll("manual");
    });
    this.renderStatusBar(new Map());

    this.addCommand({
      id: "sync-now",
      name: "Sync shared libraries now",
      callback: () => void this.sync.syncAll("manual"),
    });
    this.addCommand({
      id: "add-library",
      name: "Add a shared library",
      callback: () => new AddLibraryModal(this.app, this).open(),
    });
    this.addCommand({
      id: "resolve-conflicts",
      name: "Resolve conflicts",
      callback: () => this.openConflictModal(),
    });
    this.addCommand({
      id: "export-config",
      name: "Export configuration (copy to clipboard)",
      callback: () => void this.exportConfiguration(),
    });
    this.addCommand({
      id: "ask",
      name: "Ask your knowledge base",
      callback: () => void this.activateAskView(),
    });
    this.addCommand({
      id: "describe-libraries",
      name: "Write AI descriptions for libraries",
      callback: () => void this.describeAllLibraries(),
    });
    this.addCommand({
      id: "update-knowledge-skill",
      name: "Update the AI knowledge skill",
      callback: () => {
        this.refreshKnowledgeSkill();
        new Notice(`Covault: knowledge skill updated (${SKILL_RELPATH}).`);
      },
    });
    this.addCommand({
      id: "copy-debug-log",
      name: "Copy the diagnostic log",
      callback: () => void this.copyDebugLog(),
    });
    this.addCommand({
      id: "clear-debug-log",
      name: "Clear the diagnostic log",
      callback: () => {
        this.debugLog.clear();
        new Notice("Covault: diagnostic log cleared.");
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        const repos = this.libraryManifest.load().repos;
        const insideLib = repos.some((r) => file.path === r.path || file.path.startsWith(`${r.path}/`));
        const isRoot = file instanceof TFolder && file.isRoot();

        // History — for anything that lives in a synced repo (team
        // libraries included; their files carry the whole team's history).
        if (file instanceof TFile) {
          const ctx = this.historyContextFor(file.path);
          if (ctx) {
            menu.addItem((item) =>
              item
                .setTitle("View history")
                .setIcon("history")
                .onClick(() =>
                  new FileHistoryModal(
                    this.app,
                    this.engine,
                    ctx.ref,
                    ctx.relPath,
                    file.path,
                    this.gitAuthor().email,
                  ).open(),
                ),
            );
          }
        }

        // Sharing actions only make sense outside existing libraries.
        if (!insideLib) {
          if (file instanceof TFolder && !isRoot) {
            menu.addItem((item) =>
              item
                .setTitle("Share as knowledge library")
                .setIcon("book-up")
                .onClick(() => new ShareFolderModal(this.app, this, file.path).open()),
            );
          }

          // Marking only means something in opt-in scope — in whole-vault
          // scope everything outside the libraries is already backed up.
          if (this.settings.mainRepo && !isRoot && this.mainKbScope() === "marked") {
            if (this.isSharedToMainKb(file.path)) {
              menu.addItem((item) =>
                item
                  .setTitle("Stop sharing to my knowledge base")
                  .setIcon("book-x")
                  .onClick(() => this.unmarkSharedToMainKb(file.path)),
              );
            } else {
              menu.addItem((item) =>
                item
                  .setTitle("Share to my knowledge base")
                  .setIcon("book-plus")
                  .onClick(() => this.markSharedToMainKb(file.path)),
              );
            }
          }
        }
      }),
    );

    // Renames/moves must not orphan share marks or library folders —
    // remap manifest paths so syncing follows the content.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!this.libraryManifest.rename(oldPath, file.path)) return;
        // A mark that landed inside a team library is now redundant —
        // the library itself syncs that content.
        const manifest = this.libraryManifest.load();
        const insideLib = (p: string) =>
          manifest.repos.some((r) => p === r.path || p.startsWith(`${r.path}/`));
        for (const p of manifest.include.filter(insideLib)) this.libraryManifest.removeInclude(p);
        this.sharedRepos(); // refresh .gitignore for moved library folders
        this.refreshSettingsUI();
      }),
    );

    this.applySyncSchedule();
    // Warm the repo list so the pickers open without a spinner.
    this.app.workspace.onLayoutReady(() => {
      void this.fetchAccessibleRepos();
      this.refreshKnowledgeSkill();
    });
    // First pass shortly after startup, once the workspace has settled.
    if (this.settings.sync.auto) {
      window.setTimeout(() => void this.sync.syncAll("auto"), 5_000);
    }
  }

  /** Manifest entries, with the vault-root .gitignore kept in step so a
   *  vault that is itself a repo never swallows a nested library. */
  sharedRepos(): ManifestRepo[] {
    const repos = this.libraryManifest.load().repos;
    try {
      ensureIgnored(this.vaultBasePath(), repos.map((r) => r.path));
    } catch (e) {
      console.warn("[covault] couldn't update vault .gitignore:", e);
    }
    return repos;
  }

  /** One-time migration: settings.repos (M2) → the .covault manifest. */
  private async migrateReposToManifest(): Promise<void> {
    if (this.settings.repos.length === 0) return;
    for (const repo of this.settings.repos) this.libraryManifest.add(repo);
    this.settings.repos = [];
    await this.saveSettings();
  }

  /** Everything the background loop keeps in sync: the personal main
   *  repo (vault root, libraries excluded) first, then each library. */
  syncItems(): SyncItem[] {
    const libs = this.sharedRepos();
    const items: SyncItem[] = [];
    if (this.settings.mainRepo) {
      items.push({
        path: "",
        url: this.settings.mainRepo.url,
        branch: this.settings.mainRepo.branch,
        label: "Personal knowledge base",
        exclude: libs.map((r) => r.path),
        // Scope decides how much of the vault this repo holds; the
        // libraries above stay out of it either way.
        include: this.mainKbInclude(),
        gitdir: this.mainGitDir(),
        noAutoClone: true,
      });
    }
    return [...items, ...libs];
  }

  /** The main repo's own git directory — separate from any vault .git. */
  private mainGitDir(): string {
    return path.join(this.vaultBasePath(), ".covault", "main.git");
  }

  private toRef(item: SyncItem): RepoRef {
    return {
      dir: path.join(this.vaultBasePath(), item.path),
      url: item.url,
      branch: item.branch,
      gitdir: item.gitdir,
    };
  }

  // Repo names in the base org, cached so pickers open instantly. Warmed
  // on startup and whenever the connection changes; refreshed in the
  // background each time a picker opens.
  /** Every org this connection can reach, with their repo names. Cached
   *  as a whole rather than per-org: the API call returns all of them, and
   *  the setup dialog now lets the user switch org without refetching. */
  private repoCache: { login: string; repos: string[] }[] | null = null;
  private repoCacheInFlight: Promise<{ login: string; repos: string[] }[]> | null = null;

  /** Orgs to offer, base org first — it is the likeliest answer. */
  accessibleOrgs(): string[] {
    const logins = (this.repoCache ?? []).map((g) => g.login);
    const base = this.settings.baseOrg;
    if (base && !logins.includes(base)) logins.unshift(base);
    return base ? [base, ...logins.filter((l) => l !== base)] : logins;
  }

  /** Repo names in one org, or null while nothing has been fetched yet. */
  cachedReposIn(org: string): string[] | null {
    if (!this.repoCache) return null;
    return this.repoCache.find((g) => g.login === org)?.repos ?? [];
  }

  /** Fetch (and cache) what this connection can reach. Concurrent calls
   *  share one request; failures leave any existing cache in place. */
  async fetchAccessibleRepos(): Promise<{ login: string; repos: string[] }[]> {
    if (this.settings.authMethod !== "githubApp") return [];
    if (this.repoCacheInFlight) return this.repoCacheInFlight;
    this.repoCacheInFlight = (async () => {
      try {
        const groups = await this.appAuth.listAccessibleRepos();
        this.repoCache = groups.map((g) => ({
          login: g.login,
          // The API returns "owner/name"; the dialogs want just the name.
          repos: g.repos.map((r) => r.split("/")[1] ?? r).sort(),
        }));
        return this.repoCache;
      } catch (e) {
        console.warn("[covault] couldn't list repos:", e);
        return this.repoCache ?? [];
      } finally {
        this.repoCacheInFlight = null;
      }
    })();
    return this.repoCacheInFlight;
  }

  /** Drop the cache after actions that change what exists (create/connect). */
  invalidateRepoCache(): void {
    this.repoCache = null;
  }

  /** Resolve a vault path to the repo tracking it, plus the path within
   *  that repo — what the history views need. Null when untracked. */
  historyContextFor(vaultPath: string): { ref: RepoRef; relPath: string; label: string } | null {
    const owner = this.repoItemForPath(vaultPath);
    if (!owner) return null;
    return {
      ref: this.toRef(owner),
      relPath: owner.path ? vaultPath.slice(owner.path.length + 1) : vaultPath,
      label: owner.label ?? owner.path,
    };
  }

  /** Which synced repo (library or main KB) owns this vault path? */
  repoItemForPath(vaultPath: string): SyncItem | null {
    const items = this.syncItems();
    const key = ownerKeyForPath(vaultPath, {
      libraries: items.filter((i) => i.path).map((i) => i.path),
      hasPersonal: items.some((i) => i.path === ""),
      scope: this.mainKbScope(),
      include: this.libraryManifest.load().include,
    });
    return key === null ? null : (items.find((i) => i.path === key) ?? null);
  }

  /** Open the resolver UI for the first repo with pending conflicts. */
  openConflictModal(): void {
    const pending = this.sync.pendingConflicts()[0];
    if (!pending) {
      new Notice("Covault: no conflicts to resolve 🎉");
      return;
    }
    const item = pending.item;
    const ref = this.toRef(item);
    const ops: ConflictOps = {
      readFile: (p) => this.engine.readWorkFile(ref, p),
      writeFile: (p, c) => this.engine.writeWorkFile(ref, p, c),
      finishMerge: (paths, message) => this.engine.completeMerge(ref, paths, message),
      abortMerge: () => this.engine.discardMerge(ref),
    };
    new ConflictModal(
      this.app,
      ops,
      pending.filepaths,
      () => {
        this.sync.clearPending(item.path);
        void this.sync.syncAll("auto");
      },
      item.label ?? item.path,
      this.resolver,
    ).open();
  }

  /** How much of the vault the personal knowledge base holds. */
  mainKbScope(): MainKbScope {
    return this.libraryManifest.load().scope;
  }

  /** The engine's opt-in whitelist for the personal repo — undefined in
   *  whole-vault scope, where everything outside the libraries goes. */
  private mainKbInclude(): string[] | undefined {
    const manifest = this.libraryManifest.load();
    return manifest.scope === "vault" ? undefined : manifest.include;
  }

  /** Switch between "only what I mark" and "the whole vault". */
  async setMainKbScope(scope: MainKbScope): Promise<void> {
    if (this.mainKbScope() === scope) return;
    this.libraryManifest.setScope(scope);
    this.refreshSettingsUI();
    void this.sync.syncAll("manual");
  }

  /** Is this vault path marked "share to my knowledge base"? */
  isSharedToMainKb(vaultPath: string): boolean {
    return this.libraryManifest.load().include.some((p) => vaultPath === p || vaultPath.startsWith(`${p}/`));
  }

  markSharedToMainKb(vaultPath: string): void {
    this.libraryManifest.addInclude(vaultPath);
    this.refreshSettingsUI();
    void this.sync.syncAll("auto");
  }

  unmarkSharedToMainKb(vaultPath: string): void {
    this.libraryManifest.removeInclude(vaultPath);
    this.refreshSettingsUI();
    // Note: already-pushed copies stay in the personal repo's history;
    // un-marking only stops future updates from syncing.
  }

  /** Re-render the settings page and side panel so completed setups and
   *  list changes show immediately. */
  refreshSettingsUI(): void {
    this.settingsTab?.update();
    this.refreshPanels();
  }

  refreshPanels(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(COVAULT_VIEW_TYPE)) {
      if (leaf.view instanceof CovaultPanel) leaf.view.render();
    }
  }

  async activatePanel(reveal = true): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(COVAULT_VIEW_TYPE)[0];
    if (existing) {
      if (reveal) await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: COVAULT_VIEW_TYPE, active: reveal });
    if (reveal) await this.app.workspace.revealLeaf(leaf);
  }

  /** Register an existing shared library and start syncing it. The
   *  branch recorded is the remote's actual default — pinning "main"
   *  onto a master-era repo would leave nothing to clone. */
  /**
   * Is the selected provider usable? Every hosted provider needs a key;
   * a custom endpoint may legitimately have none (a local server), so
   * there it is the URL and model that have to be filled in.
   */
  hasModelAccess(provider: string): boolean {
    if (provider === CUSTOM_PROVIDER_ID) {
      const { baseUrl, model } = this.settings.customLlm;
      return baseUrl.length > 0 && model.length > 0;
    }
    return !!this.settings.llmKeys[provider];
  }

  /**
   * (Re)register the user's own OpenAI-compatible endpoint.
   *
   * Always registered, even while empty, so "Custom" can be picked from
   * the provider list at all — a provider that only appears once it is
   * configured cannot be configured. setProvider replaces in place, so
   * this is also how an edited URL or model id takes effect.
   */
  refreshCustomProvider(): void {
    this.models.setProvider(customProvider(this.settings.customLlm));
    if (this.settings.llm.provider === CUSTOM_PROVIDER_ID) {
      // Keep the selection pointing at whatever was just typed.
      this.settings.llm.model = this.settings.customLlm.model;
    }
  }

  /** Whether GitHub access is set up at all — see isSignedIn(settings). */
  isSignedIn(): boolean {
    return isSignedIn(this.settings);
  }

  /**
   * Set up several libraries at once.
   *
   * The slow part is one network round-trip per library to resolve its
   * default branch, so those run concurrently — bounded, because a hundred
   * libraries should not open a hundred sockets. The manifest and
   * .gitignore writes are read-modify-write, so they happen once,
   * afterwards, on the main thread's turn: doing them per-library in
   * parallel would lose entries.
   *
   * Cloning is not awaited here. It is the sync pass's job, already
   * serialized, and the caller should not sit on a modal until it ends.
   */
  async addLibraries(repos: ManifestRepo[]): Promise<{ added: ManifestRepo[]; failures: string[] }> {
    const lanes = Math.min(4, Math.max(1, repos.length));
    const queue = [...repos];
    const added: ManifestRepo[] = [];
    const failures: string[] = [];

    const resolve = async (repo: ManifestRepo): Promise<void> => {
      const dir = path.join(this.vaultBasePath(), repo.path);
      const origin = await this.engine.existingOrigin({ dir, url: repo.url, branch: repo.branch });
      if (origin && !sameRemote(origin, repo.url)) throw new FolderLinkedError(repo.path, origin);
      const remoteBranch = await this.engine.remoteDefaultBranch({ dir, url: repo.url, branch: repo.branch });
      added.push({ ...repo, branch: remoteBranch ?? repo.branch });
    };

    await Promise.all(
      Array.from({ length: lanes }, async () => {
        for (let repo = queue.shift(); repo; repo = queue.shift()) {
          try {
            await resolve(repo);
          } catch (e) {
            failures.push(`${repo.path}: ${(e as Error).message}`);
            this.debugLog.op("import", `couldn't set up ${repo.path}`, { error: e });
          }
        }
      }),
    );

    if (added.length > 0) {
      // Sorted for a stable manifest regardless of which lane finished first.
      for (const repo of added.sort((a, b) => a.path.localeCompare(b.path))) {
        this.libraryManifest.add(repo);
      }
      this.sharedRepos(); // one .gitignore refresh for the batch
      this.refreshSettingsUI();
      void this.sync
        .syncAll("manual")
        .then(() => Promise.all(added.map((r) => this.generateLibraryDescription(r.path))));
    }
    return { added, failures };
  }

  async addLibrary(repo: ManifestRepo): Promise<void> {
    const dir = path.join(this.vaultBasePath(), repo.path);
    const origin = await this.engine.existingOrigin({ dir, url: repo.url, branch: repo.branch });
    if (origin && !sameRemote(origin, repo.url)) throw new FolderLinkedError(repo.path, origin);
    const remoteBranch = await this.engine.remoteDefaultBranch({ dir, url: repo.url, branch: repo.branch });
    this.libraryManifest.add({ ...repo, branch: remoteBranch ?? repo.branch });
    this.sharedRepos(); // refresh .gitignore
    this.refreshSettingsUI();
    // Describe after the sync pass — a cloned library has no content
    // to describe until then.
    void this.sync.syncAll("manual").then(() => this.generateLibraryDescription(repo.path));
  }

  /** Rebuild the knowledge-routing skill (kernel index) and the agent
   *  adapters from what's on disk right now. Cheap (directory walks
   *  only), so it runs after every sync pass. */
  refreshKnowledgeSkill(): void {
    try {
      const repos = this.libraryManifest.load().repos;
      writeKnowledgeSkill(this.vaultBasePath(), repos);
      if (this.settings.announceToAgents) writeAdapters(this.vaultBasePath(), repos);
    } catch (e) {
      console.warn("[covault] couldn't update the knowledge skill:", e);
    }
  }

  /**
   * Apply a confirmed import plan — exactly the plan, nothing else.
   * Settings first (one save), then the new libraries (each clones on
   * the sync pass this kicks off).
   */
  async applyConfigImport(plan: ImportPlan): Promise<void> {
    if (plan.newLibraries.length > 0 && !this.isSignedIn()) {
      throw new Error("Sign in to GitHub first (Settings → Covault → GitHub) — the libraries can't be fetched without it.");
    }
    for (const change of plan.changes) {
      switch (change.key) {
        case "baseOrg":
          this.settings.baseOrg = String(change.value);
          break;
        case "llmProvider":
          this.settings.llm.provider = String(change.value);
          this.settings.llm.model = "";
          break;
        case "llmModel":
          this.settings.llm.model = String(change.value);
          break;
        case "syncAuto":
          this.settings.sync.auto = Boolean(change.value);
          break;
        case "syncInterval":
          this.settings.sync.intervalMinutes = Number(change.value);
          break;
        case "askApprove":
          this.settings.ask.requireApproval = Boolean(change.value);
          break;
        case "askMcp":
          this.settings.ask.mcpServers = String(change.value);
          break;
        case "askCliHints":
          this.settings.ask.cliHints = String(change.value);
          this.cliInventory.refresh();
          break;
        case "announceAgents":
          await this.setAnnounceToAgents(Boolean(change.value));
          break;
        case "personalKbScope":
          this.libraryManifest.setScope(change.value === "vault" ? "vault" : "marked");
          break;
      }
    }
    await this.saveSettings();
    this.applySyncSchedule();

    this.debugLog.op("import", "configuration import", {
      changes: plan.changes.length,
      libraries: plan.newLibraries.length,
    });
    this.refreshSettingsUI();
    if (plan.newLibraries.length === 0) return;

    // Deliberately not awaited by the caller's dialog: setting up
    // libraries is network work whose length depends on how many there
    // are, and the user should be back in their vault while it happens.
    new Notice(
      `Covault: setting up ${plan.newLibraries.length} librar${plan.newLibraries.length === 1 ? "y" : "ies"} in the background…`,
    );
    const { added, failures } = await this.addLibraries(plan.newLibraries);
    if (added.length > 0) {
      new Notice(`Covault: ${added.length} librar${added.length === 1 ? "y is" : "ies are"} being downloaded.`);
    }
    if (failures.length > 0) {
      new Notice(`Covault: ${failures.length} couldn't be set up —\n${failures.join("\n")}`, 15_000);
    }
  }

  /** Copy the secret-free configuration snapshot to the clipboard. */
  async exportConfiguration(): Promise<void> {
    const data = buildConfigExport(this.settings, this.libraryManifest.load());
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    new Notice("Covault: configuration copied to the clipboard (no keys, tokens or personal details included).");
  }

  /** Each Ask view gets its own engine — its own conversation. */
  newAskEngine(): AskEngine {
    const libraryDeps = {
      vaultBase: () => this.vaultBasePath(),
      repos: () => this.libraryManifest.load().repos,
    };
    return new AskEngine({
      models: this.models,
      getSelection: () => this.settings.llm,
      hasKey: (provider) => this.hasModelAccess(provider),
      // Assembled fresh per question: the toggles and MCP config are live.
      requireApproval: () => this.settings.ask.requireApproval,
      tools: async () => {
        const tools: AskTool[] = [
          makeSearchTool(libraryDeps),
          makeReadTool(libraryDeps),
          // Edits ride the normal sync loop — committed and shared like
          // hand-made changes, undoable through File History.
          ...makeEditTools({ ...libraryDeps, onMutation: () => void this.sync.syncAll("auto") }),
          makeRunCommandTool(
            () => this.vaultBasePath(),
            () => this.cliInventory.env(),
          ),
        ];
        tools.push(...(await this.mcp.tools()));
        return tools;
      },
      libraryMap: () => {
        try {
          return fs.readFileSync(path.join(this.vaultBasePath(), SKILL_RELPATH), "utf8");
        } catch {
          return null;
        }
      },
      cliManifest: () => this.cliInventory.manifest(),
      // A failure is recorded whether or not debug mode was on — it is the
      // only record of why a question couldn't reach the model.
      onTransport: (line, failed) =>
        failed ? this.debugLog.op("llm", line) : this.debugLog.log("llm", line),
      // Second look at a failed request, outside the renderer's CORS rules.
      diagnose: describeEndpoint,
    });
  }

  async activateAskView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(COVAULT_ASK_VIEW_TYPE)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: COVAULT_ASK_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /** Backfill: describe every library that doesn't have a line yet. */
  async describeAllLibraries(): Promise<void> {
    if (!this.describer.isEnabled()) {
      new Notice("Covault: configure an AI provider and key in Settings first.");
      return;
    }
    const missing = this.libraryManifest.load().repos.filter((r) => !r.description);
    if (missing.length === 0) {
      new Notice("Covault: every library already has a description.");
      return;
    }
    new Notice(`Covault: describing ${missing.length} librar${missing.length === 1 ? "y" : "ies"}…`);
    let done = 0;
    for (const repo of missing) {
      if (await this.generateLibraryDescription(repo.path)) done += 1;
    }
    this.refreshSettingsUI();
    new Notice(`Covault: described ${done} of ${missing.length} librar${missing.length === 1 ? "y" : "ies"}.`);
  }

  /**
   * Draft a library's one-line description and store it in the manifest.
   * Fire-and-forget: runs only on this device (the one that created or
   * added the library — a single writer, so devices never race), only
   * once (existing descriptions are kept), and only when a model is
   * configured. Failures just leave the description empty.
   */
  async generateLibraryDescription(folderPath: string): Promise<boolean> {
    try {
      const repo = this.libraryManifest.load().repos.find((r) => r.path === folderPath);
      if (!repo || repo.description || !this.describer.isEnabled()) return false;
      const line = await this.describer.describe(gatherFacts(this.vaultBasePath(), repo));
      if (!line) return false;
      this.libraryManifest.setDescription(folderPath, line);
      this.refreshKnowledgeSkill(); // adapters render the new description
      return true;
    } catch (e) {
      console.warn(`[covault] couldn't describe "${folderPath}":`, e);
      return false;
    }
  }

  /** Toggle handler: on → write the adapters now; off → remove them. */
  async setAnnounceToAgents(enabled: boolean): Promise<void> {
    this.settings.announceToAgents = enabled;
    await this.saveSettings();
    try {
      if (enabled) writeAdapters(this.vaultBasePath(), this.libraryManifest.load().repos);
      else removeAdapters(this.vaultBasePath());
    } catch (e) {
      console.warn("[covault] couldn't update the agent adapters:", e);
    }
  }

  /** Detach a library: drop it from the manifest AND delete the folder's
   *  git state, so the folder is an ordinary folder again (re-sharing it
   *  later must not trip over a stale link). The notes stay on disk unless
   *  `deleteFiles` says otherwise; the .git is only removed when it really
   *  is this library's. `deletedFolder` reports whether the delete actually
   *  happened — it is refused when the folder holds work GitHub never got,
   *  because the dialog promised the team's copy covers everything. */
  async removeLibrary(repoPath: string, opts: { deleteFiles?: boolean } = {}): Promise<{ deletedFolder: boolean }> {
    if (this.removingLibraries.has(repoPath)) return { deletedFolder: false };
    this.removingLibraries.add(repoPath);
    try {
      const repo = this.libraryManifest.load().repos.find((r) => r.path === repoPath);
      this.libraryManifest.remove(repoPath);
      this.sharedRepos(); // refresh .gitignore
      // Out of the manifest already, so this either awaits the round still in
      // flight or returns at once — never starts a sync of a gone library.
      await this.sync.syncJust(repoPath);
      // That round may have ended in error or conflict — forget it, or the
      // status bar keeps reporting a library that no longer exists.
      this.sync.forget(repoPath);
      const ref = repo
        ? { dir: path.join(this.vaultBasePath(), repoPath), url: repo.url, branch: repo.branch }
        : null;
      if (opts.deleteFiles) {
        const keep = ref !== null && (await this.engine.hasUnpushedWork(ref));
        if (!keep) await this.deleteVaultFolder(repoPath);
        return { deletedFolder: !keep };
      }
      if (ref && repo) {
        const origin = await this.engine.existingOrigin(ref).catch(() => null);
        if (origin && sameRemote(origin, repo.url)) this.unlinkFolder(repoPath);
      }
      return { deletedFolder: false };
    } finally {
      this.removingLibraries.delete(repoPath);
      this.refreshSettingsUI();
    }
  }

  /** Delete a folder's git link (its .git directory). Notes are untouched. */
  unlinkFolder(folderPath: string): void {
    fs.rmSync(path.join(this.vaultBasePath(), folderPath, ".git"), { recursive: true, force: true });
  }

  /**
   * Delete a vault folder and everything under it.
   *
   * Obsidian first, so the notes follow the user's "deleted files" setting
   * (system trash, vault trash, or gone) and the vault index keeps up. The
   * fs sweep after it is for what Obsidian does not index — the .git
   * directory, chiefly — and is a no-op when the trash already took the
   * whole folder.
   */
  private async deleteVaultFolder(folderPath: string): Promise<void> {
    const abs = path.join(this.vaultBasePath(), folderPath);
    // The .git never rides into the trash: with the vault-trash setting,
    // trashFile moves the whole folder under .trash/, which would leave a
    // live repo sitting there — and restoring the notes from the trash
    // would restore the stale link with them.
    fs.rmSync(path.join(abs, ".git"), { recursive: true, force: true });
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (folder) await this.app.fileManager.trashFile(folder);
    fs.rmSync(abs, { recursive: true, force: true });
  }

  /** Create a brand-new shared library repo in `org` backed by a fresh
   *  vault folder, and start syncing it. Throws RepoExistsError when the
   *  name is taken — the caller offers "connect instead" (see
   *  attachExistingLibrary). */
  async createSharedLibrary(org: string, name: string, folderPath: string): Promise<void> {
    const token = await this.appAuth.getRepoCreationToken(org);
    const repo = await createOrgRepo(token, org, name, true);
    fs.mkdirSync(path.join(this.vaultBasePath(), folderPath), { recursive: true });
    await this.shareFolder(folderPath, repo.url);
  }

  /**
   * The other library this folder is still linked to, if any.
   *
   * Cheap and local (it reads the folder's git config), so a caller can
   * ask before starting the network work rather than discovering it by
   * catching FolderLinkedError halfway through.
   */
  async conflictingOrigin(folderPath: string, url: string): Promise<string | null> {
    const dir = path.join(this.vaultBasePath(), folderPath);
    const origin = await this.engine.existingOrigin({ dir, url, branch: "main" });
    return origin && !sameRemote(origin, url) ? origin : null;
  }

  /** Bind a folder to an already-existing library repo: the library's
   *  content wins (local versions of overlapping notes are kept aside),
   *  then keep it synced. The remote's own default branch is followed;
   *  a repo with no branches at all gets seeded from the folder. */
  async attachExistingLibrary(folderPath: string, url: string, branch: string): Promise<void> {
    return this.sync.runExclusive(folderPath, folderPath, () => this.bindLibrary(folderPath, url, branch));
  }

  private async bindLibrary(folderPath: string, url: string, branch: string): Promise<void> {
    const dir = path.join(this.vaultBasePath(), folderPath);
    // Never take over a folder that already belongs to somewhere else —
    // adoptRemote would repoint its origin and overwrite its content.
    // Retrying our own earlier attempt (same address) is fine.
    const origin = await this.engine.existingOrigin({ dir, url, branch });
    if (origin && !sameRemote(origin, url)) throw new FolderLinkedError(folderPath, origin);
    const remoteBranch = await this.engine.remoteDefaultBranch({ dir, url, branch });
    if (!remoteBranch) {
      // No branches at all: nothing to pull — the folder seeds the repo.
      await this.shareFolder(folderPath, url, branch);
      void this.sync.syncAll("manual");
      return;
    }
    const hasContent = fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
    if (!hasContent) {
      // Empty/missing folder: plain clone via the normal add path.
      await this.addLibrary({ path: folderPath, url, branch: remoteBranch });
      return;
    }
    const backedUp = await this.engine.adoptRemote({ dir, url, branch: remoteBranch });
    this.libraryManifest.add({ path: folderPath, url, branch: remoteBranch });
    this.sharedRepos(); // refresh .gitignore
    this.refreshSettingsUI();
    void this.generateLibraryDescription(folderPath);
    if (backedUp.length > 0) {
      new Notice(`Covault: kept your versions of ${backedUp.length} note(s) as "(local copy)".`, 10_000);
    }
    void this.sync.syncAll("manual");
  }

  /**
   * Bind the vault root to a personal repo (main KB).
   *
   * mode "create": the repo is brand new — the marked notes become its
   * first commit. mode "adopt": the repo already has content, which wins;
   * overlapping local notes are kept aside as "(local copy)". Neither
   * path can produce a merge conflict, which matters because setup often
   * happens before an AI provider is configured.
   */
  /** Registered as a task so the panel shows it and no sync round starts
   *  on the personal repo underneath it. */
  async setupMainKb(url: string, branch: string, mode: "create" | "adopt"): Promise<void> {
    return this.sync.runExclusive("", "Personal knowledge base", () => this.buildMainKb(url, branch, mode));
  }

  private async buildMainKb(url: string, branch: string, mode: "create" | "adopt"): Promise<void> {
    const gitdir = this.mainGitDir();
    // A previous failed attempt may have left a half-built repo; it holds
    // nothing anyone depends on (mainRepo was never saved), so restart clean.
    fs.rmSync(gitdir, { recursive: true, force: true });

    // Adopt whatever branch the remote actually calls default; a repo
    // with no branches at all has nothing to adopt — this vault seeds it,
    // same as a brand-new one.
    const remoteBranch =
      mode === "adopt" ? await this.engine.remoteDefaultBranch({ dir: this.vaultBasePath(), url, branch, gitdir }) : null;
    const effective = mode === "adopt" && !remoteBranch ? "create" : mode;
    if (remoteBranch) branch = remoteBranch;
    const ref = { dir: this.vaultBasePath(), url, branch, gitdir };

    if (effective === "create") {
      const exclude = this.sharedRepos().map((r) => r.path); // also refreshes .gitignore
      await this.engine.initAndPush(ref, "Set up personal knowledge base", {
        exclude,
        include: this.mainKbInclude(),
      });
    } else {
      const backedUp = await this.engine.adoptRemote(ref);
      if (backedUp.length > 0) {
        new Notice(`Covault: kept your versions of ${backedUp.length} note(s) as "(local copy)".`, 10_000);
      }
    }

    this.settings.mainRepo = { url, branch };
    await this.saveSettings();
    this.refreshSettingsUI();
    void this.sync.syncAll("manual");
  }

  /** Create-and-upload flow for ShareFolderModal (repo already created). */
  async shareFolder(folderPath: string, url: string, branch = "main"): Promise<void> {
    const ref = { dir: path.join(this.vaultBasePath(), folderPath), url, branch };
    // Taking over a folder that already belongs to another repo would
    // repoint its remote and push its content somewhere it never asked
    // to go. Retries of our own attempts (same address) are fine.
    const origin = await this.engine.existingOrigin(ref);
    if (origin && !sameRemote(origin, url)) throw new FolderLinkedError(folderPath, origin);
    await this.engine.initAndPush(ref, `Share ${folderPath} as a knowledge library`);
    this.libraryManifest.add({ path: folderPath, url, branch: ref.branch });
    this.sharedRepos(); // refresh .gitignore
    this.refreshSettingsUI();
    void this.generateLibraryDescription(folderPath);
  }

  /** (Re)arm the background sync timer from current settings. */
  onunload(): void {
    // MCP stdio servers are child processes — they must not outlive us.
    void this.mcp.dispose();
  }

  applySyncSchedule(): void {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    if (!this.settings.sync.auto) return;
    this.syncIntervalId = window.setInterval(
      () => void this.sync.syncAll("auto"),
      this.settings.sync.intervalMinutes * 60_000,
    );
    this.registerInterval(this.syncIntervalId);
  }

  /**
   * Opening line of a debug session: without it a log pasted into a bug
   * report says what happened but not on what. Called when debug mode is
   * switched on, and on load when it is already on.
   */
  logDebugHeader(): void {
    this.debugLog.op("session", "session start", {
      plugin: this.manifest.version,
      obsidian: apiVersion,
      platform: process.platform,
      libraries: this.libraryManifest.load().repos.length,
      mainRepo: this.settings.mainRepo !== null,
      autoSync: this.settings.sync.auto,
      intervalMinutes: this.settings.sync.intervalMinutes,
    });
  }

  /** Hand the collected log to the user — the point of collecting it. */
  private async copyDebugLog(): Promise<void> {
    const text = this.debugLog.format();
    if (!text) {
      new Notice("Covault: nothing logged yet — reproduce the problem, then copy again.", 8_000);
      return;
    }
    await navigator.clipboard.writeText(text);
    new Notice(`Covault: diagnostic log copied (${this.debugLog.snapshot().length} entries).`);
  }

  /** Commit email of the current user — history views mark their own rows. */
  gitAuthorEmail(): string {
    return this.gitAuthor().email;
  }

  private gitAuthor(): { name: string; email: string } {
    const custom = this.settings.author;
    const login = this.settings.githubApp.connections[0]?.login;
    return {
      name: custom.name || login || "Covault",
      email: custom.email || (login ? noreplyEmail(login) : "covault@users.noreply.github.com"),
    };
  }

  /**
   * Fill the commit identity from GitHub after signing in.
   *
   * Only fills what is empty — a name the user typed themselves is theirs
   * to keep. The real profile is readable only with a user-scoped token
   * (PAT mode); a GitHub App installation token acts as the app and gets
   * 403 on /user, so App mode derives from the login it already has.
   */
  async refreshAuthorFromGitHub(): Promise<void> {
    const login = this.settings.githubApp.connections[0]?.login;
    let identity: GitHubIdentity | null = null;
    if (this.settings.authMethod === "pat" && this.settings.githubToken) {
      try {
        identity = await fetchUserIdentity(this.settings.githubToken);
      } catch (e) {
        // Never block sign-in on this: the fallback below is always valid.
        this.debugLog.log("auth", "couldn't read the GitHub profile", { error: e });
      }
    }
    const name = identity?.name || identity?.login || login;
    const email = identity?.email || (identity?.login ?? login ? noreplyEmail(identity?.login ?? login ?? "") : null);
    if (!name && !email) return;

    let changed = false;
    if (!this.settings.author.name && name) {
      this.settings.author.name = name;
      changed = true;
    }
    if (!this.settings.author.email && email) {
      this.settings.author.email = email;
      changed = true;
    }
    if (!changed) return;
    await this.saveSettings();
    this.debugLog.log("auth", "commit identity filled from GitHub", {
      source: identity ? "profile" : "login",
      email: this.settings.author.email,
    });
    this.refreshSettingsUI();
  }

  private renderStatusBar(states: ReadonlyMap<string, RepoState>): void {
    const all = [...states.values()];
    // Tasks, not just phases: setting up a knowledge base and adopting a
    // library run outside the phase machinery, and the status bar used to
    // read "up to date" through the whole of one.
    const tasks = this.sync.activeTasks();
    const text = tasks.length > 0
      ? tasks.length === 1
        ? `Covault: ${tasks[0]!.label}…`
        : `Covault: syncing ${tasks.length}…`
      : all.some((s) => s.phase === "syncing")
        ? "Covault: syncing…"
        : all.some((s) => s.phase === "conflict")
          ? "Covault: needs attention"
          : all.some((s) => s.phase === "error")
            ? "Covault: sync issue"
            : "Covault: up to date";
    this.statusBarEl.setText(text);
    this.statusBarEl.setAttribute(
      "aria-label",
      tasks.length > 0 ? tasks.map((t) => t.label).join(", ") : "Covault — click to sync",
    );
  }

  /** Vault location on disk — the key for the per-device secret file. */
  vaultBasePath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    throw new Error("Covault requires a local vault (desktop only).");
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<CovaultSettings> | null;
    this.settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...raw,
      githubApp: { connections: raw?.githubApp?.connections ?? [] },
      llm: { ...DEFAULT_SETTINGS.llm, ...raw?.llm },
      llmKeys: { ...raw?.llmKeys },
      sync: { ...DEFAULT_SETTINGS.sync, ...raw?.sync },
      ask: { ...DEFAULT_SETTINGS.ask, ...raw?.ask },
      repos: raw?.repos ?? [],
      author: { ...DEFAULT_SETTINGS.author, ...raw?.author },
    };

    const secrets = readSecrets(this.vaultBasePath());
    if (secrets) {
      if (settingsHaveInlineSecrets(raw)) {
        // data.json from an old version (or copied vault) still carries
        // secrets — rewrite it redacted, keep the external store canonical.
        await this.saveSettings();
      }
      applySecrets(this.settings, secrets);
    } else if (settingsHaveInlineSecrets(raw)) {
      // First run after upgrade: migrate inline secrets out of the vault.
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    writeSecrets(this.vaultBasePath(), extractSecrets(this.settings));
    await this.saveData(redactSecrets(this.settings));
  }

  /** Hard reset: wipe local credentials (settings UI will expose this). */
  async resetCredentials(): Promise<void> {
    clearSecrets(this.vaultBasePath());
    this.settings.githubToken = "";
    this.settings.deviceId = "";
    this.settings.githubApp = { connections: [] };
    this.settings.llmKeys = {};
    await this.saveSettings();
  }
}

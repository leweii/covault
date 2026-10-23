import {
  apiVersion,
  FileSystemAdapter,
  Notice,
  normalizePath,
  Plugin,
  TFile,
  TFolder,
} from "obsidian";
import * as fs from "fs";
import * as path from "path";
import type { MutableModels } from "@earendil-works/pi-ai";
import { DEFAULT_DOC_STATUSES, DEFAULT_SETTINGS, isSignedIn, type CovaultSettings } from "./settings";
import { sanitizeDocStatuses } from "./workbench/docStatus";
import { GitEngine } from "./git/GitEngine";
import { createNodeHttp } from "./git/nodeHttp";
import { DebugLog } from "./debug/logger";
import { SyncHistory } from "./debug/syncHistory";
import { AutomationStore } from "./automation/store";
import { AutomationRunner } from "./automation/runner";
import { AutomationDesigner } from "./automation/designer";
import { modelReady, type ModelDeps } from "./automation/agent";
import type { NoteToolDeps } from "./automation/noteTools";
import { AutomationView, COVAULT_AUTOMATION_VIEW_TYPE } from "./ui/AutomationView";
import { SyncController, type RepoState, type SyncItem } from "./sync/SyncController";
import { AppAuth } from "./auth/AppAuth";
import { PROTOCOL_ACTION } from "./auth/constants";
import { ManifestStore, type MainKbScope, type ManifestRepo } from "./covault/manifest";
import { ensureIgnored } from "./covault/gitignore";
import { ownerKeyForPath } from "./covault/ownership";
import { sameRemote } from "./git/urls";
import { FolderLinkedError } from "./covault/errors";
import {
  migrateLegacySkill,
  removeKnowledgeSkill,
  writeKnowledgeSkill,
} from "./covault/skill";
import { purgeLegacyAgentBlock } from "./covault/legacyAgentBlock";
import { libraryAttachmentFolder } from "./covault/attachments";
import { buildConfigExport, type ImportPlan } from "./covault/exportConfig";
import { ShareFolderModal } from "./ui/ShareFolderModal";
import { ConflictModal, type ConflictOps } from "./ui/ConflictModal";
import { FileHistoryModal } from "./ui/FileHistoryModal";
import { SyncHistoryModal } from "./ui/SyncHistoryModal";
import { CovaultPanel, COVAULT_VIEW_TYPE } from "./ui/CovaultPanel";
import { describeEndpoint } from "./llm/reachability";
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
  debugLog!: DebugLog;
  syncHistory!: SyncHistory;
  automations!: AutomationStore;
  automationRunner!: AutomationRunner;
  private settingsTab: CovaultSettingTab | null = null;
  private statusBarEl!: HTMLElement;
  private syncIntervalId: number | null = null;
  /** When the next automatic sync fires; null while automatic sync is off. */
  private nextSyncAt: number | null = null;
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
    this.syncHistory = new SyncHistory({
      fs,
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
    this.installAttachmentRouting();
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


    this.automations = new AutomationStore({
      fs,
      dir: () => path.join(appConfigDir(), "automations"),
      vaultKey: () => vaultKey(this.vaultBasePath()),
    });
    this.automationRunner = new AutomationRunner({
      store: this.automations,
      model: this.automationModelDeps(),
      notes: this.automationNoteDeps(),
      repos: () => this.libraryManifest.load().repos,
      vaultName: () => this.app.vault.getName(),
      // Written notes are committed and shared like hand-made edits.
      onNotesChanged: () => void this.sync.syncAll("auto"),
      onChange: () => this.refreshAutomationViews(),
      log: (message, data) => this.debugLog.op("automation", message, data),
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
        onRound: (record) => this.syncHistory.append(record),
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
    this.registerView(COVAULT_AUTOMATION_VIEW_TYPE, (leaf) => new AutomationView(leaf, this));
    // The scheduler: cheap when nothing is due (a pass over a short list).
    // The list re-renders too, so "next in 5 min" stays honest.
    this.registerInterval(
      window.setInterval(() => {
        this.automationRunner.tick();
        this.refreshAutomationViews();
      }, 30_000),
    );
    this.addRibbonIcon("library", "Open Covault panel", () => void this.activatePanel());
    // The one palette entry: everything else is a button in the panel,
    // so finding the panel has to be easy. No default hotkey (Obsidian's
    // guidelines) — users can bind one in Settings → Hotkeys.
    this.addCommand({
      id: "open-panel",
      name: "Open Covault panel",
      callback: () => void this.activatePanel(),
    });
    // The panel lives in the left sidebar as its own tab, beside Files and
    // Search, so its icon is always there to click.
    this.app.workspace.onLayoutReady(() => void this.ensurePanelInLeftSidebar());

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("mod-clickable");
    this.statusBarEl.onClickEvent(() => {
      if (this.sync.pendingConflicts().length > 0) this.openConflictModal();
      else void this.sync.syncAll("manual");
    });
    this.renderStatusBar(new Map());


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
        if (!insideLib && !isRoot) {
          // Marking only means something in opt-in scope — in whole-vault
          // scope everything outside the libraries is already backed up.
          const marked = this.mainKbScope() === "marked" && this.isSharedToMainKb(file.path);
          if (file instanceof TFolder) {
            // One entry for both destinations; the dialog defaults to the
            // personal knowledge base and asks for an org only when the
            // user goes for a team library.
            menu.addItem((item) =>
              item
                .setTitle("Share…")
                .setIcon("book-up")
                .onClick(() => new ShareFolderModal(this.app, this, file.path).open()),
            );
          } else if (this.settings.mainRepo && this.mainKbScope() === "marked" && !marked) {
            // A single note has only one destination — no dialog needed.
            menu.addItem((item) =>
              item
                .setTitle("Share to my knowledge base")
                .setIcon("book-plus")
                .onClick(() => this.markSharedToMainKb(file.path)),
            );
          }
          if (marked) {
            menu.addItem((item) =>
              item
                .setTitle("Stop sharing to my knowledge base")
                .setIcon("book-x")
                .onClick(() => this.unmarkSharedToMainKb(file.path)),
            );
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
    // One cleanup for however many times the timer is re-armed (settings
    // changes, the workbench's "Sync now") — registerInterval per re-arm
    // would pile up a closure each time.
    this.register(() => {
      if (this.syncIntervalId !== null) window.clearInterval(this.syncIntervalId);
    });
    // Accounts connected before identity filling existed have empty
    // fields; the repo warm-up below brings the backend's email if new.
    void this.refreshAuthorFromGitHub();
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

  /** Orgs to offer. No default among them: picking where knowledge goes
   *  is an explicit choice at the moment of sharing, not a stored setting. */
  accessibleOrgs(): string[] {
    return (this.repoCache ?? []).map((g) => g.login);
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

  /**
   * Open the resolver for a repo's conflicts — the given repo, or the
   * first with any — starting on `focusPath` when the user came from one
   * note. Always the repo's whole set: a merge is finished for all of
   * its files at once.
   */
  openConflictModal(repoPath?: string, focusPath?: string): void {
    const all = this.sync.pendingConflicts();
    const pending = repoPath === undefined ? all[0] : all.find((p) => p.item.path === repoPath);
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
      focusPath,
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

  /**
   * Attachments pasted or dropped into a library's note are saved inside
   * that library (libraryAttachmentFolder, relative to its root), so they
   * sync with it. Everything else keeps Obsidian's own setting.
   *
   * getAvailablePathForAttachment is the public hook both paste and drop
   * go through. Wrapped, not replaced: outside a library — or with the
   * setting empty — the original decides. Restored on unload only if
   * nobody wrapped it after us, so we never undo another plugin's patch.
   */
  private installAttachmentRouting(): void {
    const fm = this.app.fileManager;
    const original = fm.getAvailablePathForAttachment.bind(fm);
    const routed = async (filename: string, sourcePath?: string): Promise<string> => {
      const note = sourcePath ?? this.app.workspace.getActiveFile()?.path;
      const folder = libraryAttachmentFolder(this.libraryManifest.load().repos, note, this.settings.libraryAttachmentFolder);
      if (!folder) return original(filename, sourcePath);
      const { vault } = this.app;
      const dir = normalizePath(folder);
      if (!vault.getAbstractFileByPath(dir)) {
        try {
          await vault.createFolder(dir);
        } catch {
          /* exists on disk but not indexed yet — the save still works */
        }
      }
      const dot = filename.lastIndexOf(".");
      const base = dot > 0 ? filename.slice(0, dot) : filename;
      const ext = dot > 0 ? filename.slice(dot + 1) : "";
      // First free name, the way Obsidian numbers its own: "x.png", "x 1.png"…
      // adapter.exists, not the index: a file just pulled may not be indexed.
      for (let n = 0; ; n++) {
        const candidate = `${dir}/${base}${n ? ` ${n}` : ""}${ext ? `.${ext}` : ""}`;
        if (!(await vault.adapter.exists(candidate))) return candidate;
      }
    };
    fm.getAvailablePathForAttachment = routed;
    this.register(() => {
      if (fm.getAvailablePathForAttachment === routed) fm.getAvailablePathForAttachment = original;
    });
  }

  /** Model plumbing for automations — the same AI settings as conflict merging. */
  private automationModelDeps(): ModelDeps {
    return {
      models: this.models,
      getSelection: () => this.settings.llm,
      hasKey: (provider) => this.hasModelAccess(provider),
      onTransport: (line, failed) => (failed ? this.debugLog.op("llm", line) : this.debugLog.log("llm", line)),
      diagnose: describeEndpoint,
    };
  }

  automationModelReady(): boolean {
    return modelReady(this.automationModelDeps());
  }

  private automationNoteDeps(): NoteToolDeps {
    return {
      vaultBase: () => this.vaultBasePath(),
      repos: () => this.libraryManifest.load().repos,
      writeNote: (vaultPath, content) => this.writeVaultNote(vaultPath, content),
    };
  }

  /** Create or overwrite a note through the vault, so editors and the
   *  explorer see it at once. Falls back to the adapter for a file that
   *  exists on disk but isn't indexed yet (just pulled by a sync). */
  async writeVaultNote(vaultPath: string, content: string): Promise<void> {
    const p = normalizePath(vaultPath);
    const { vault } = this.app;
    const existing = vault.getAbstractFileByPath(p);
    if (existing instanceof TFile) {
      await vault.modify(existing, content);
      return;
    }
    const dir = p.split("/").slice(0, -1).join("/");
    if (dir && !vault.getAbstractFileByPath(dir)) {
      try {
        await vault.createFolder(dir);
      } catch {
        /* created meanwhile, or exists unindexed — the write below decides */
      }
    }
    try {
      await vault.create(p, content);
    } catch {
      await vault.adapter.write(p, content);
    }
  }

  newAutomationDesigner(): AutomationDesigner {
    return new AutomationDesigner({
      store: this.automations,
      runner: this.automationRunner,
      model: this.automationModelDeps(),
      notes: this.automationNoteDeps(),
      vaultName: () => this.app.vault.getName(),
      onChange: () => this.refreshAutomationViews(),
    });
  }

  refreshAutomationViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(COVAULT_AUTOMATION_VIEW_TYPE)) {
      if (leaf.view instanceof AutomationView) leaf.view.refresh();
    }
  }

  /** The Automations tab, in the main area like a note. */
  async activateAutomationView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(COVAULT_AUTOMATION_VIEW_TYPE)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: COVAULT_AUTOMATION_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  onunload(): void {
    this.automationRunner?.stop();
  }

  refreshPanels(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(COVAULT_VIEW_TYPE)) {
      if (leaf.view instanceof CovaultPanel) leaf.view.render();
    }
  }

  /** The sync-status pane, on demand. Nothing opens it on its own any
   *  more — it is somewhere you go when a library looks wrong, not
   *  something to keep an eye on. */
  async activatePanel(): Promise<void> {
    await this.ensurePanelInLeftSidebar();
    const leaf = this.app.workspace.getLeavesOfType(COVAULT_VIEW_TYPE)[0];
    if (leaf) await this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Keep exactly one panel, in the left sidebar. Earlier versions put it
   * in the right one; a panel found anywhere else is moved over, quietly
   * (not revealed — this runs at startup).
   */
  private async ensurePanelInLeftSidebar(): Promise<void> {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(COVAULT_VIEW_TYPE);
    const inLeft = leaves.find((l) => l.getRoot() === workspace.leftSplit);
    for (const l of leaves) if (l !== inLeft) l.detach();
    if (inLeft) return;
    const leaf = workspace.getLeftLeaf(false);
    await leaf?.setViewState({ type: COVAULT_VIEW_TYPE, active: false });
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
      void this.sync.syncAll("manual");
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
    void this.sync.syncAll("manual");
  }

  /** Rebuild the knowledge-routing skill from what's on disk right now.
   *  Cheap (directory walks only), so it runs after every sync pass.
   *
   *  The skill is for the *other* agents on this machine, so the toggle
   *  governs it: off means nothing of ours in the shared skill folders.
   *
   *  Both cleanups run regardless of the toggle — they undo things past
   *  versions wrote, and a vault should not have to turn a feature on to
   *  get rid of them. */
  refreshKnowledgeSkill(): void {
    try {
      const base = this.vaultBasePath();
      migrateLegacySkill(base);
      purgeLegacyAgentBlock(base);
      const repos = this.libraryManifest.load().repos;
      if (this.settings.announceToAgents) writeKnowledgeSkill(base, repos);
      else removeKnowledgeSkill(base);
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
        case "libraryAttachmentFolder":
          this.settings.libraryAttachmentFolder = String(change.value);
          break;
        case "docStatuses": {
          // Carried as JSON (an import change is a scalar); already validated by the plan.
          const statuses = sanitizeDocStatuses(JSON.parse(String(change.value)));
          if (statuses) this.settings.docStatuses = statuses;
          break;
        }
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

  /** Toggle handler: on → write the skill now; off → remove it. */
  async setAnnounceToAgents(enabled: boolean): Promise<void> {
    this.settings.announceToAgents = enabled;
    await this.saveSettings();
    this.refreshKnowledgeSkill();
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
  }

  /**
   * (Re)arm the background sync timer from current settings. Only a
   * settings change and the workbench's own "Sync now" re-arm it: a retry
   * of one library or an automation's sync must not move the countdown.
   */
  applySyncSchedule(): void {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    this.nextSyncAt = null;
    if (!this.settings.sync.auto) return;
    const interval = this.settings.sync.intervalMinutes * 60_000;
    this.nextSyncAt = Date.now() + interval;
    this.syncIntervalId = window.setInterval(() => {
      this.nextSyncAt = Date.now() + interval;
      void this.sync.syncAll("auto");
    }, interval);
  }

  /** When the next automatic sync fires, or null while automatic sync is off. */
  nextAutoSyncAt(): number | null {
    return this.nextSyncAt;
  }

  /** A full pass just ran by hand — the wait for the next one starts over. */
  restartSyncCountdown(): void {
    this.applySyncSchedule();
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

  clearDebugLog(): void {
    this.debugLog.clear();
    new Notice("Covault: diagnostic log cleared.");
  }

  openSyncHistory(): void {
    new SyncHistoryModal(this.app, this.syncHistory).open();
  }

  /** Hand the collected log to the user — the point of collecting it. */
  async copyDebugLog(): Promise<void> {
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

  /** Display name of the current user — what a status is "set by". */
  gitAuthorName(): string {
    return this.gitAuthor().name;
  }

  private gitAuthor(): { name: string; email: string } {
    const custom = this.settings.author;
    const conn = this.settings.githubApp.connections[0];
    return {
      name: custom.name || conn?.login || "Covault",
      email: custom.email || conn?.email || (conn ? noreplyEmail(conn.login) : "covault@users.noreply.github.com"),
    };
  }

  /** AppAuthHost: the backend told us (or updated) the account's email. */
  onIdentity(): void {
    void this.refreshAuthorFromGitHub();
  }

  /**
   * Fill the commit identity from the GitHub account: the name is the
   * login, the email the account's own — its verified primary, else its
   * public address, else GitHub's `<id>+<login>` no-reply address.
   *
   * Only fills what is empty — a name or email the user typed themselves
   * is theirs to keep. The one exception is the bare
   * `<login>@users.noreply.github.com` earlier versions filled in as a
   * stand-in: that was never the user's choice, so the real address
   * replaces it once known.
   *
   * App mode gets the email from the backend (an installation token acts
   * as the app and can't read the user's emails); PAT mode reads it with
   * the PAT itself.
   */
  async refreshAuthorFromGitHub(): Promise<void> {
    const author = this.settings.author;
    // `<login>@users.noreply…` without the numeric id is the stand-in.
    const standIn = /^[^+@]+@users\.noreply\.github\.com$/i.test(author.email);
    if (author.name && author.email && !standIn) return; // nothing to fill — skip the network
    const conn = this.settings.githubApp.connections[0];
    let login: string | undefined;
    let email: string | null = null;
    if (this.settings.authMethod === "pat") {
      if (!this.settings.githubToken) return;
      try {
        const identity: GitHubIdentity | null = await fetchUserIdentity(this.settings.githubToken);
        login = identity?.login;
        email = identity?.email ?? null;
      } catch (e) {
        // Never block sign-in on this: the commit identity has fallbacks.
        this.debugLog.log("auth", "couldn't read the GitHub profile", { error: e });
      }
    } else {
      login = conn?.login;
      email = conn?.email ?? null;
    }
    if (!login) return;

    let changed = false;
    if (!author.name) {
      author.name = login;
      changed = true;
    }
    if (email && (!author.email || (standIn && email !== author.email))) {
      author.email = email;
      changed = true;
    }
    if (!changed) return;
    await this.saveSettings();
    this.debugLog.log("auth", "commit identity filled from GitHub", { name: author.name, email: author.email });
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
      repos: raw?.repos ?? [],
      author: { ...DEFAULT_SETTINGS.author, ...raw?.author },
      // data.json is hand-editable: a malformed list falls back to the defaults.
      docStatuses: sanitizeDocStatuses(raw?.docStatuses) ?? structuredClone(DEFAULT_DOC_STATUSES),
    };
    // Left behind by versions that had the built-in Ask agent.
    delete (this.settings as { ask?: unknown }).ask;

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

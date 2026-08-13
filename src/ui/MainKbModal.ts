import { Modal, Notice, Setting, type App } from "obsidian";
import type CovaultPlugin from "../main";
import { addCollaborator, createOrgRepo, repoExists, RepoExistsError } from "../git/githubApi";
import { ConfirmModal } from "./ConfirmModal";

/**
 * Guided personal knowledge base setup. One editable repo-name field,
 * validated live (debounced) against the base org:
 *   - name exists  → "will connect to it and pull" / button: Connect
 *   - name is free → "will be created"            / button: Create
 * Probing uses an un-narrowed token — narrowed tokens 404 on everything
 * outside their allowlist, which would make the check meaningless.
 */
export class MainKbModal extends Modal {
  private name: string;
  private exists: boolean | null = null; // null = check pending/unknown
  private token = "";
  private busy = false;
  private checkSeq = 0;
  private debounceId: number | null = null;

  private statusEl!: HTMLElement;
  private ctaBtn!: HTMLButtonElement;

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
    const org = this.plugin.settings.baseOrg;

    if (!org) {
      contentEl.createEl("p", {
        text: "Choose a base organization first (Settings → Covault → GitHub).",
      });
      return;
    }

    contentEl.createEl("p", {
      text:
        `Connects this vault to a personal repo in ${org}. Everything stays private by default — ` +
        `only notes and folders you mark “Share to my knowledge base” are backed up there for the team.`,
    });

    new Setting(contentEl)
      .setName("Repository name")
      .setDesc(`In ${org} — convention: personal-kb-<you>.`)
      .addText((t) =>
        t.setValue(this.name).onChange((v) => {
          this.name = v.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
          this.scheduleCheck();
        }),
      );

    this.statusEl = contentEl.createDiv({ cls: "setting-item-description" });

    new Setting(contentEl).addButton((btn) => {
      this.ctaBtn = btn.buttonEl;
      btn
        .setButtonText("Set up")
        .setCta()
        .onClick(() => void this.submit());
    });

    void this.runCheck();
  }

  private scheduleCheck(): void {
    if (this.debounceId !== null) window.clearTimeout(this.debounceId);
    this.exists = null;
    this.statusEl.setText(this.name ? "…" : "Enter a repository name.");
    this.ctaBtn.disabled = true;
    this.debounceId = window.setTimeout(() => void this.runCheck(), 450);
  }

  /** Live existence check; stale responses (fast typing) are discarded. */
  private async runCheck(): Promise<void> {
    const org = this.plugin.settings.baseOrg;
    const name = this.name;
    if (!name) return;
    const seq = ++this.checkSeq;
    this.statusEl.setText(`Checking ${org}/${name}…`);
    this.ctaBtn.disabled = true;
    try {
      if (!this.token) this.token = await this.plugin.appAuth.getRepoCreationToken(org);
      const exists = await repoExists(this.token, org, name);
      if (seq !== this.checkSeq) return; // superseded by newer input
      this.exists = exists;
      if (exists) {
        this.statusEl.setText(
          `✓ ${org}/${name} already exists — your vault will connect to it and pull its contents in.`,
        );
        this.ctaBtn.setText("Connect and pull");
      } else {
        this.statusEl.setText(`✨ ${org}/${name} doesn't exist yet — it will be created (private).`);
        this.ctaBtn.setText("Create and set up");
      }
      this.ctaBtn.disabled = false;
    } catch (e) {
      if (seq !== this.checkSeq) return;
      // Can't verify (offline, token trouble): allow submit, which
      // re-validates via the create→exists fallback anyway.
      this.exists = null;
      this.statusEl.setText(`Couldn't check (${(e as Error).message}) — you can still continue.`);
      this.ctaBtn.setText("Set up");
      this.ctaBtn.disabled = false;
    }
  }

  private async submit(): Promise<void> {
    if (this.busy || !this.name) return;
    const s = this.plugin.settings;
    const org = s.baseOrg;
    const login = s.githubApp.connections[0]?.login;
    const idleLabel = this.ctaBtn.textContent ?? "Set up";
    this.busy = true;
    this.ctaBtn.disabled = true;
    this.ctaBtn.setText("Setting up…");
    try {
      const token = this.token || (await this.plugin.appAuth.getRepoCreationToken(org));

      if (this.exists !== true) {
        try {
          await createOrgRepo(token, org, this.name, true);
        } catch (e) {
          // Check was skipped/stale and the name is taken — same answer:
          // offer to connect to the existing repo.
          if (!(e instanceof RepoExistsError)) throw e;
          const ok = await ConfirmModal.ask(this.app, {
            title: "Repository already exists",
            message:
              `"${this.name}" already exists in ${org}. Connect your vault to it instead? ` +
              `Its current contents will be pulled in and merged with your notes first.`,
            cta: "Connect and pull",
          });
          if (!ok) {
            this.busy = false;
            this.ctaBtn.disabled = false;
            this.ctaBtn.setText(idleLabel);
            return;
          }
        }
      }

      if (login) {
        // Best-effort: the App owns the repo's creation, so make sure the
        // human owner can write. Others keep the org default (read-only).
        try {
          await addCollaborator(token, org, this.name, login, "admin");
        } catch (e) {
          console.warn("[covault] couldn't add owner as collaborator:", e);
        }
      }

      await this.plugin.setupMainKb(`https://github.com/${org}/${this.name}.git`, "main");
      new Notice(`Covault: your personal knowledge base is connected to ${org}/${this.name}.`);
      this.close();
    } catch (e) {
      new Notice(`Covault: setup failed — ${(e as Error).message}`);
      this.ctaBtn.disabled = false;
      this.ctaBtn.setText(idleLabel);
      this.busy = false;
    }
  }

  onClose(): void {
    if (this.debounceId !== null) window.clearTimeout(this.debounceId);
    this.contentEl.empty();
  }
}

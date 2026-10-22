import { Modal, Notice, setIcon, type App } from "obsidian";
import { RECOMMENDED_PLUGINS, type RecommendedPlugin } from "../covault/recommendedPlugins";

/** The slice of Obsidian's (undocumented) plugin manager this guide reads. */
interface PluginManager {
  manifests: Record<string, unknown>;
  enabledPlugins: Set<string>;
  enablePluginAndSave(id: string): Promise<boolean>;
}

type Status = "missing" | "disabled" | "enabled";

/**
 * Guide to the community plugins that pair with Covault: one row each,
 * with the next step as its button — install (opens the plugin's page in
 * Obsidian's community browser), enable, or done.
 *
 * Installing happens in Obsidian's own browser, which this dialog can't
 * observe, so the rows re-check their status while the dialog is open.
 */
export class RecommendedPluginsModal extends Modal {
  private timer: number | null = null;
  private painted = "";

  constructor(app: App) {
    super(app);
  }

  private get plugins(): PluginManager {
    return (this.app as App & { plugins: PluginManager }).plugins;
  }

  private status(id: string): Status {
    if (!this.plugins.manifests[id]) return "missing";
    return this.plugins.enabledPlugins.has(id) ? "enabled" : "disabled";
  }

  onOpen(): void {
    this.modalEl.addClass("covault-rec-modal");
    this.titleEl.setText("Recommended plugins");
    this.paint();
    this.timer = window.setInterval(() => this.paint(), 1_000);
  }

  onClose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.contentEl.empty();
  }

  /** Re-render only when some status actually changed. */
  private paint(): void {
    const snapshot = RECOMMENDED_PLUGINS.map((p) => this.status(p.id)).join(",");
    if (snapshot === this.painted) return;
    this.painted = snapshot;

    const el = this.contentEl;
    el.empty();
    el.createEl("p", {
      cls: "covault-rec-intro",
      text: "These plugins pair well with your shared libraries. Install the ones you want — each opens in Obsidian's plugin browser.",
    });
    const list = el.createDiv("covault-rec-list");
    for (const plugin of RECOMMENDED_PLUGINS) this.renderRow(list, plugin);
  }

  private renderRow(list: HTMLElement, plugin: RecommendedPlugin): void {
    const status = this.status(plugin.id);
    const row = list.createDiv("covault-rec-row");
    const info = row.createDiv("covault-rec-info");
    info.createDiv({ cls: "covault-rec-name", text: plugin.name });
    info.createDiv({ cls: "covault-rec-desc", text: plugin.description });

    if (status === "enabled") {
      const done = row.createDiv("covault-rec-done");
      setIcon(done.createSpan(), "check");
      done.createSpan({ text: "Installed" });
      return;
    }
    if (status === "disabled") {
      const btn = row.createEl("button", { text: "Enable", cls: "mod-cta" });
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await this.plugins.enablePluginAndSave(plugin.id);
        } catch (e) {
          new Notice(`Covault: couldn't enable ${plugin.name} — ${(e as Error).message}`);
        }
        this.paint();
      };
      return;
    }
    const btn = row.createEl("button", { text: "Install", cls: "mod-cta" });
    btn.onclick = () => window.open(`obsidian://show-plugin?id=${encodeURIComponent(plugin.id)}`);
  }
}

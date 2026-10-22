import { Modal, TFile, setIcon, type App } from "obsidian";
import type { UnseenUpdates } from "../sync/SyncController";

const KIND_LABEL = { added: "New", modified: "Updated", deleted: "Removed" } as const;

/**
 * What teammates changed in one library since the user last looked: one
 * row per note, click to open it. Opening this marks the updates seen.
 */
export class UpdatesModal extends Modal {
  constructor(
    app: App,
    private library: string,
    /** Vault path of the library's folder ("" for the vault root). */
    private folder: string,
    private updates: UnseenUpdates,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("covault-updates-modal");
    this.titleEl.setText(`New in ${this.library}`);
    const { files, authors, since } = this.updates;
    const who = authors.size > 0 ? ` by ${[...authors].join(", ")}` : "";
    this.contentEl.createEl("p", {
      cls: "covault-updates-intro",
      text: `${files.size} note(s) changed${who} since ${new Date(since).toLocaleString()}.`,
    });

    const list = this.contentEl.createDiv("covault-updates-list");
    const sorted = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [filepath, kind] of sorted) {
      const vaultPath = this.folder ? `${this.folder}/${filepath}` : filepath;
      const file = kind === "deleted" ? null : this.app.vault.getAbstractFileByPath(vaultPath);
      const row = list.createDiv(`covault-updates-row is-${kind}`);
      setIcon(row.createSpan("covault-updates-icon"), kind === "added" ? "file-plus" : kind === "deleted" ? "file-x" : "file-pen");
      row.createSpan({ cls: "covault-updates-kind", text: KIND_LABEL[kind] });
      row.createSpan({ cls: "covault-updates-path", text: filepath });
      if (file instanceof TFile) {
        row.addClass("is-openable");
        row.onclick = () => {
          void this.app.workspace.getLeaf(false).openFile(file);
          this.close();
        };
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

import { FuzzySuggestModal, Notice, TFile, TFolder, type App, type TAbstractFile } from "obsidian";
import type CovaultPlugin from "../main";

/** Picker for "share a note or folder to my knowledge base". */
export class SharePickerModal extends FuzzySuggestModal<TAbstractFile> {
  constructor(
    app: App,
    private plugin: CovaultPlugin,
    private onDone: () => void,
  ) {
    super(app);
    this.setPlaceholder("Share which note or folder?");
  }

  getItems(): TAbstractFile[] {
    const libs = this.plugin.libraryManifest.load().repos;
    const insideLib = (p: string) => libs.some((r) => p === r.path || p.startsWith(`${r.path}/`));
    return this.app.vault
      .getAllLoadedFiles()
      .filter(
        (f) =>
          (f instanceof TFile || f instanceof TFolder) &&
          f.path !== "/" &&
          !insideLib(f.path) &&
          !this.plugin.isSharedToMainKb(f.path),
      );
  }

  getItemText(f: TAbstractFile): string {
    return f.path;
  }

  onChooseItem(f: TAbstractFile): void {
    this.plugin.markSharedToMainKb(f.path);
    new Notice(`Covault: "${f.path}" will be shared on the next sync (running now).`);
    this.onDone();
  }
}

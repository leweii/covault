/** Typed errors that setup dialogs recover from (never shown raw). */

/** The target folder already carries a git link to some other repo. */
export class FolderLinkedError extends Error {
  constructor(
    public folderPath: string,
    public origin: string,
  ) {
    super(`"${folderPath}" is already linked to ${origin}.`);
    this.name = "FolderLinkedError";
  }
}

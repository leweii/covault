/**
 * Where an attachment pasted or dropped into a team library's note goes:
 * a folder inside that library (relative to its root), so the file syncs
 * with the notes that embed it. Obsidian's own "default location for new
 * attachments" is vault-wide — commonly a root folder like
 * `Attachments/` — and a file landing there never reaches teammates: the
 * note syncs, the image doesn't, and everyone else sees a broken embed.
 *
 * Notes outside every library are left to Obsidian's setting.
 */
import type { ManifestRepo } from "./manifest";

export const DEFAULT_LIBRARY_ATTACHMENT_FOLDER = "attachments";

/**
 * The folder setting, normalized: forward slashes, no leading/trailing
 * slash, no empty segments. Throws on anything that could leave the
 * library or land in machinery ("..", ".git", ".obsidian"…).
 * An empty string means "off — use Obsidian's own setting".
 */
export function normalizeAttachmentFolder(raw: string): string {
  const parts = raw
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p !== ".");
  for (const p of parts) {
    if (p === ".." || p.startsWith(".")) {
      throw new Error(`"${raw.trim()}" isn't allowed — use a plain folder path inside the library, like "attachments".`);
    }
  }
  return parts.join("/");
}

/**
 * The vault path of the attachment folder for a note, or null when the
 * note isn't in a library (or the feature is off). Nested libraries are
 * not a thing, but the longest matching root wins anyway.
 */
export function libraryAttachmentFolder(
  repos: ManifestRepo[],
  notePath: string | undefined,
  folderSetting: string,
): string | null {
  if (!notePath || !folderSetting) return null;
  const owner = repos
    .filter((r) => notePath.startsWith(`${r.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return owner ? `${owner.path}/${folderSetting}` : null;
}

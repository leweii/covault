/**
 * Which synced repo owns a vault path.
 *
 * Pulled out of the plugin because it decides something user-visible —
 * whether a note has history to show — and got that wrong once: the
 * personal repo's claim was tested against the manifest's `include` list,
 * which only opt-in scope populates, so in a whole-vault setup every note
 * outside a library looked unsynced.
 */
import type { MainKbScope } from "./manifest";

export interface OwnershipInput {
  /** Vault-relative paths of the shared libraries. */
  libraries: readonly string[];
  /** Is a personal knowledge base configured at all? */
  hasPersonal: boolean;
  scope: MainKbScope;
  /** Paths marked for the personal repo; only consulted in "marked" scope. */
  include: readonly string[];
}

/** True when `vaultPath` is `prefix` itself or sits inside it. */
function isUnder(vaultPath: string, prefix: string): boolean {
  return vaultPath === prefix || vaultPath.startsWith(`${prefix}/`);
}

/**
 * The owning repo's key — a library path, `""` for the personal repo, or
 * null when nothing syncs this path. A library always wins: its folder is
 * excluded from the personal repo either way.
 */
export function ownerKeyForPath(vaultPath: string, input: OwnershipInput): string | null {
  for (const library of input.libraries) {
    if (isUnder(vaultPath, library)) return library;
  }
  if (!input.hasPersonal) return null;
  // Whole-vault scope covers everything the libraries didn't take.
  if (input.scope === "vault") return "";
  return input.include.some((marked) => isUnder(vaultPath, marked)) ? "" : null;
}

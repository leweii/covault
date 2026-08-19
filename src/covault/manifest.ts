/**
 * .covault/covault.json — the single source of truth for which vault
 * folders are shared knowledge libraries (the "virtual submodule" map).
 *
 * It lives at the vault root so that users who sync their vault root as a
 * personal repo propagate it: a teammate adds a library, everyone's next
 * sync sees the new manifest entry and clones the folder automatically.
 */
import * as fs from "fs";
import * as path from "path";

export interface ManifestRepo {
  /** Vault-relative folder path, e.g. "teams/platform-kb". */
  path: string;
  url: string;
  branch: string;
}

/**
 * How much of the vault the personal knowledge base holds:
 *   "marked" — opt-in (the default): only the `include` paths.
 *   "vault"  — everything, minus the team libraries and vault machinery.
 * Team library folders stay out in both modes: a note belongs to exactly
 * one knowledge base, never to two at once.
 */
export type MainKbScope = "marked" | "vault";

export interface CovaultManifest {
  version: 1;
  repos: ManifestRepo[];
  /**
   * Vault paths marked "share to my knowledge base". Consulted only in
   * "marked" scope — everything else is private by default.
   */
  include: string[];
  scope: MainKbScope;
}

const EMPTY: CovaultManifest = { version: 1, repos: [], include: [], scope: "marked" };

export class ManifestStore {
  constructor(private vaultBase: string) {}

  private filePath(): string {
    return path.join(this.vaultBase, ".covault", "covault.json");
  }

  load(): CovaultManifest {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath(), "utf8")) as Partial<CovaultManifest>;
      const repos = Array.isArray(raw.repos)
        ? raw.repos.filter(
            (r): r is ManifestRepo =>
              typeof r?.path === "string" && typeof r?.url === "string" && typeof r?.branch === "string",
          )
        : [];
      const include = Array.isArray(raw.include) ? raw.include.filter((p): p is string => typeof p === "string") : [];
      // Anything unrecognized — including manifests written before scopes
      // existed — means the private-by-default mode.
      const scope: MainKbScope = raw.scope === "vault" ? "vault" : "marked";
      return { version: 1, repos, include, scope };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  save(manifest: CovaultManifest): void {
    const file = this.filePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  }

  add(repo: ManifestRepo): CovaultManifest {
    const manifest = this.load();
    if (manifest.repos.some((r) => r.path === repo.path)) return manifest;
    manifest.repos.push(repo);
    manifest.repos.sort((a, b) => a.path.localeCompare(b.path));
    this.save(manifest);
    return manifest;
  }

  remove(repoPath: string): CovaultManifest {
    const manifest = this.load();
    manifest.repos = manifest.repos.filter((r) => r.path !== repoPath);
    this.save(manifest);
    return manifest;
  }

  /** Mark a vault path as shared to the personal knowledge base. */
  addInclude(vaultPath: string): CovaultManifest {
    const manifest = this.load();
    if (!manifest.include.includes(vaultPath)) {
      // Drop entries the new path already covers (marking a parent).
      manifest.include = manifest.include.filter((p) => !(p === vaultPath || p.startsWith(`${vaultPath}/`)));
      manifest.include.push(vaultPath);
      manifest.include.sort();
      this.save(manifest);
    }
    return manifest;
  }

  /** Switch the personal knowledge base between opt-in and whole-vault. */
  setScope(scope: MainKbScope): CovaultManifest {
    const manifest = this.load();
    if (manifest.scope !== scope) {
      manifest.scope = scope;
      this.save(manifest);
    }
    return manifest;
  }

  /** Stop sharing a path (exact entries only). */
  removeInclude(vaultPath: string): CovaultManifest {
    const manifest = this.load();
    manifest.include = manifest.include.filter((p) => p !== vaultPath);
    this.save(manifest);
    return manifest;
  }

  /**
   * A vault file/folder was renamed or moved — remap every library path
   * and share mark under the old path so syncing follows the content.
   * Returns whether anything changed.
   */
  rename(oldPath: string, newPath: string): boolean {
    const remap = (p: string) =>
      p === oldPath ? newPath : p.startsWith(`${oldPath}/`) ? newPath + p.slice(oldPath.length) : p;

    const manifest = this.load();
    let changed = false;
    for (const repo of manifest.repos) {
      const next = remap(repo.path);
      if (next !== repo.path) {
        repo.path = next;
        changed = true;
      }
    }
    const nextInclude = [...new Set(manifest.include.map(remap))];
    if (nextInclude.some((p, i) => p !== manifest.include[i]) || nextInclude.length !== manifest.include.length) {
      manifest.include = nextInclude;
      changed = true;
    }
    if (changed) {
      manifest.repos.sort((a, b) => a.path.localeCompare(b.path));
      manifest.include.sort();
      this.save(manifest);
    }
    return changed;
  }
}

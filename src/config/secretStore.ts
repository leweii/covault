// Per-device secret store — credentials live OUTSIDE the vault.
//
// The vault is a Git repo that is synced to a remote and routinely
// cloned/copied between machines and people. Anything written into the
// vault (or into `data.json`, which sits under `<vault>/<configDir>/
// plugins/covault/`) can therefore leak. Sharing such a file hands the
// recipient the owner's backend `sessionId` + `deviceId` (full
// impersonation), GitHub PAT, and every LLM provider key.
//
// So secrets are kept in a file under the OS user-config directory — per
// machine, never inside any vault, never synced:
//
//   macOS    ~/Library/Application Support/covault/
//   Windows  %APPDATA%\covault\           (…\AppData\Roaming\…)
//   Linux    $XDG_CONFIG_HOME/covault/    (default ~/.config/…)
//
// `data.json` keeps only non-secret machine state; see redactSecrets().
// Pattern proven in agentic-git-sync.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import type { CovaultSettings, GitHubAppConnection } from "../settings";

const APP_DIR_NAME = "covault";
const SECRETS_VERSION = 1 as const;

function env(key: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[key] : undefined;
}

/** OS-appropriate per-user config directory, outside any vault. */
function appConfigDir(): string {
  const home = os.homedir();
  switch (os.platform()) {
    case "win32":
      return path.join(env("APPDATA") || path.join(home, "AppData", "Roaming"), APP_DIR_NAME);
    case "darwin":
      return path.join(home, "Library", "Application Support", APP_DIR_NAME);
    default:
      return path.join(env("XDG_CONFIG_HOME") || path.join(home, ".config"), APP_DIR_NAME);
  }
}

/**
 * One secret file per vault, keyed by the vault's absolute path, so two
 * vaults open on the same machine don't clobber each other's credentials.
 * The basename is a hash so the filename doesn't leak the vault path.
 */
function secretFilePath(vaultBasePath: string): string {
  const key = crypto.createHash("sha256").update(vaultBasePath).digest("hex").slice(0, 16);
  return path.join(appConfigDir(), `vault-${key}.json`);
}

export interface LocalSecrets {
  version: typeof SECRETS_VERSION;
  deviceId: string;
  githubToken: string;
  connections: GitHubAppConnection[];
  /** LLM API keys keyed by pi-ai provider id. */
  llmKeys: Record<string, string>;
}

/** Pull the secret fields out of an in-memory settings object. */
export function extractSecrets(s: CovaultSettings): LocalSecrets {
  return {
    version: SECRETS_VERSION,
    deviceId: s.deviceId ?? "",
    githubToken: s.githubToken ?? "",
    connections: s.githubApp?.connections ?? [],
    llmKeys: { ...(s.llmKeys ?? {}) },
  };
}

/** Overlay external secrets onto an in-memory settings object (mutates). */
export function applySecrets(s: CovaultSettings, sec: LocalSecrets): void {
  s.deviceId = sec.deviceId ?? "";
  s.githubToken = sec.githubToken ?? "";
  s.githubApp = { connections: sec.connections ?? [] };
  s.llmKeys = { ...(sec.llmKeys ?? {}) };
}

/**
 * A copy of settings with every secret blanked — exactly what is allowed
 * to be written into `data.json`. Non-secret fields pass through.
 */
export function redactSecrets(s: CovaultSettings): CovaultSettings {
  return {
    ...s,
    githubToken: "",
    deviceId: "",
    githubApp: { connections: [] },
    llmKeys: {},
  };
}

/** True if a raw data.json blob still carries any inline secret (→ migrate). */
export function settingsHaveInlineSecrets(s: Partial<CovaultSettings> | null): boolean {
  if (!s) return false;
  if (s.githubToken) return true;
  if (s.deviceId) return true;
  if (s.githubApp?.connections?.length) return true;
  if (s.llmKeys && Object.values(s.llmKeys).some((v) => v)) return true;
  return false;
}

/** Read the external secret file for a vault, or null if missing/unreadable. */
export function readSecrets(vaultBasePath: string): LocalSecrets | null {
  try {
    const file = secretFilePath(vaultBasePath);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LocalSecrets>;
    return {
      version: SECRETS_VERSION,
      deviceId: typeof raw.deviceId === "string" ? raw.deviceId : "",
      githubToken: typeof raw.githubToken === "string" ? raw.githubToken : "",
      connections: Array.isArray(raw.connections) ? raw.connections : [],
      llmKeys: raw.llmKeys && typeof raw.llmKeys === "object" ? { ...raw.llmKeys } : {},
    };
  } catch (e) {
    console.warn("[covault] couldn't read secret store:", e);
    return null;
  }
}

/** Write the external secret file (owner-only perms where supported). */
export function writeSecrets(vaultBasePath: string, secrets: LocalSecrets): void {
  fs.mkdirSync(appConfigDir(), { recursive: true });
  const file = secretFilePath(vaultBasePath);
  fs.writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  // mode on open() is masked by umask and ignored on Windows; chmod again
  // so a pre-existing looser file is tightened.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows / filesystem without POSIX perms — nothing to do. */
  }
}

/** Delete the external secret file (used by the hard reset). */
export function clearSecrets(vaultBasePath: string): void {
  try {
    fs.unlinkSync(secretFilePath(vaultBasePath));
  } catch {
    /* already absent */
  }
}

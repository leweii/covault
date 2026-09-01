/**
 * Configuration export and import: enough to reproduce a Covault setup on
 * another machine, with secrets and personal identity excluded.
 *
 * Built as an ALLOWLIST in both directions — fields are picked one by one,
 * never "settings minus the bad ones" — so a future secret field can't
 * leak by being forgotten here, and a hostile file can't reach a setting
 * import was never meant to touch. Out by design: the PAT, API keys,
 * backend sessions, the device id, and the commit identity (name/email),
 * which belongs to a person rather than to a setup. MCP server configs are
 * exported but their env values (a favourite place for tokens) are masked,
 * which is also why import refuses to restore a masked one.
 */
import type { CovaultSettings } from "../settings";
import type { CovaultManifest, ManifestRepo } from "./manifest";

/** 2 dropped `settings.author`; 3 dropped `settings.baseOrg` (there is no
 *  stored organization any more — it is chosen per library). An older file may
 *  still carry either; import ignores both. */
export const EXPORT_VERSION = 3;

const REDACTED = "«redacted»";

/** MCP config with every env value masked; invalid JSON passes through
 *  untouched (it holds no parseable secrets and the user may be mid-edit). */
export function redactMcpConfig(json: string): string {
  const trimmed = json.trim();
  if (!trimmed) return "";
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return json;
  }
  const maskEnv = (server: unknown): unknown => {
    if (!server || typeof server !== "object") return server;
    const s = server as Record<string, unknown>;
    if (s.env && typeof s.env === "object") {
      s.env = Object.fromEntries(Object.keys(s.env).map((k) => [k, REDACTED]));
    }
    return s;
  };
  if (Array.isArray(raw)) raw.forEach(maskEnv);
  else if (raw && typeof raw === "object") {
    const table = ((raw as Record<string, unknown>).mcpServers ?? raw) as Record<string, unknown>;
    for (const key of Object.keys(table)) maskEnv(table[key]);
  }
  return JSON.stringify(raw, null, 2);
}

export function buildConfigExport(settings: CovaultSettings, manifest: CovaultManifest): object {
  return {
    covaultExport: EXPORT_VERSION,
    settings: {
      authMethod: settings.authMethod,
      // No author here on purpose: the commit identity is who you are, not
      // how the vault is set up, and it is re-derived from the GitHub
      // login on sign-in anyway.
      llm: { provider: settings.llm.provider, model: settings.llm.model },
      sync: { auto: settings.sync.auto, intervalMinutes: settings.sync.intervalMinutes },
      ask: {
        requireApproval: settings.ask.requireApproval,
        mcpServers: redactMcpConfig(settings.ask.mcpServers),
        cliHints: settings.ask.cliHints,
      },
      announceToAgents: settings.announceToAgents,
      personalKb: settings.mainRepo ? { url: settings.mainRepo.url, branch: settings.mainRepo.branch } : null,
    },
    personalKbScope: { scope: manifest.scope, include: manifest.include },
    libraries: manifest.repos.map((r) => ({
      path: r.path,
      url: r.url,
      branch: r.branch,
      ...(r.description ? { description: r.description } : {}),
    })),
  };
}

// ── Import ────────────────────────────────────────────────────────

/**
 * Settings an import is allowed to write. Deliberately absent, even though
 * they are in the file:
 *  - `authMethod` — swapping it can lock you out of your own sign-in.
 *  - `personalKb` — someone else's personal repo is not yours.
 *  - `author` — identity; see the module comment.
 *  - `personalKbScope.include` — paths in the exporter's vault, not yours.
 */
export type ImportKey =
  | "llmProvider"
  | "llmModel"
  | "syncAuto"
  | "syncInterval"
  | "askApprove"
  | "askMcp"
  | "askCliHints"
  | "announceAgents"
  | "personalKbScope";

/** One field the user is asked to confirm before it is written. */
export interface ImportChange {
  key: ImportKey;
  /** Human label for the confirmation list. */
  label: string;
  from: string;
  to: string;
  /** The value to assign when confirmed. */
  value: string | number | boolean;
}

export interface ImportPlan {
  /** Fields whose value would actually change. */
  changes: ImportChange[];
  /** Libraries in the file that this vault doesn't have yet. */
  newLibraries: ManifestRepo[];
  /** Libraries already set up here, left alone. */
  existingLibraries: number;
  /** Things in the file that import refuses to touch, and why. */
  skipped: string[];
}

const MASK_MARKER = REDACTED;

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Validate a pasted export. Throws a message meant to be shown as-is —
 * everything here is user-pasted text, so nothing is assumed about shape.
 */
export function parseConfigImport(text: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    throw new Error("That isn't valid JSON — copy the whole configuration, including the outer { }.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("That JSON isn't a Covault configuration.");
  }
  const version = (raw as Record<string, unknown>).covaultExport;
  if (typeof version !== "number") {
    throw new Error("That JSON isn't a Covault configuration (no covaultExport version).");
  }
  if (version > EXPORT_VERSION) {
    throw new Error(`That configuration comes from a newer Covault (format ${version}) — update the plugin first.`);
  }
  return raw as Record<string, unknown>;
}

/**
 * Work out what importing would change, without changing anything. The
 * user confirms this list; nothing outside it is ever written.
 */
export function planConfigImport(
  current: CovaultSettings,
  currentManifest: CovaultManifest,
  file: Record<string, unknown>,
): ImportPlan {
  const changes: ImportChange[] = [];
  const skipped: string[] = [];
  const settings = (file.settings ?? {}) as Record<string, unknown>;
  const llm = (settings.llm ?? {}) as Record<string, unknown>;
  const sync = (settings.sync ?? {}) as Record<string, unknown>;
  const ask = (settings.ask ?? {}) as Record<string, unknown>;

  const add = (
    key: ImportKey,
    label: string,
    from: string | number | boolean,
    to: string | number | boolean | null,
  ) => {
    if (to === null || to === from) return;
    changes.push({ key, label, from: String(from) || "(empty)", to: String(to) || "(empty)", value: to });
  };

  add("llmProvider", "AI provider", current.llm.provider, asString(llm.provider));
  add("llmModel", "AI model", current.llm.model, asString(llm.model));
  add("syncAuto", "Automatic sync", current.sync.auto, asBool(sync.auto));
  add(
    "syncInterval",
    "Sync interval (minutes)",
    current.sync.intervalMinutes,
    typeof sync.intervalMinutes === "number" ? sync.intervalMinutes : null,
  );
  add("askApprove", "Ask approval required", current.ask.requireApproval, asBool(ask.requireApproval));
  add("askCliHints", "Extra CLI notes for Ask", current.ask.cliHints, asString(ask.cliHints));
  add("announceAgents", "Announce libraries to AI assistants", current.announceToAgents, asBool(settings.announceToAgents));

  // Exported with its env values masked, so restoring it would write
  // "«redacted»" in place of real tokens and quietly break the servers.
  const mcp = asString(ask.mcpServers);
  if (mcp && mcp.includes(MASK_MARKER)) {
    skipped.push("Connected services (MCP) — the export masks their tokens, so they must be re-entered by hand.");
  } else {
    add("askMcp", "Connected services (MCP)", current.ask.mcpServers, mcp);
  }

  const scope = (file.personalKbScope ?? {}) as Record<string, unknown>;
  const wanted = asString(scope.scope);
  if (wanted === "marked" || wanted === "vault") {
    add("personalKbScope", "Personal notes shared", currentManifest.scope, wanted);
  }
  if (Array.isArray(scope.include) && scope.include.length > 0) {
    skipped.push("The exporter's list of individually shared notes — those paths belong to their vault, not yours.");
  }
  if (settings.personalKb) skipped.push("Their personal knowledge base — that repo is theirs, not yours.");
  if (settings.authMethod && settings.authMethod !== current.authMethod) {
    skipped.push("Their sign-in method — changing it here could lock you out of your own account.");
  }
  if ((settings as { author?: unknown }).author) {
    skipped.push("Their name and email — your commit identity comes from your own GitHub sign-in.");
  }

  const have = new Set(currentManifest.repos.map((r) => r.path));
  const libraries = Array.isArray(file.libraries) ? file.libraries : [];
  const newLibraries: ManifestRepo[] = [];
  for (const entry of libraries) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const repoPath = asString(row.path);
    const url = asString(row.url);
    if (!repoPath || !url) continue;
    if (have.has(repoPath)) continue;
    newLibraries.push({
      path: repoPath,
      url,
      branch: asString(row.branch) ?? "main",
      ...(asString(row.description) ? { description: asString(row.description) as string } : {}),
    });
  }

  return {
    changes,
    newLibraries,
    existingLibraries: libraries.length - newLibraries.length,
    skipped,
  };
}

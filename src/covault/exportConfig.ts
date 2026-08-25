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

/** 2 dropped `settings.author` — a v1 file may still carry it, and import
 *  ignores it either way. */
export const EXPORT_VERSION = 2;

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
      s.env = Object.fromEntries(Object.keys(s.env as object).map((k) => [k, REDACTED]));
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
      baseOrg: settings.baseOrg,
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

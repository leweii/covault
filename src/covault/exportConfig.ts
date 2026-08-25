/**
 * Configuration export: everything needed to describe (or reproduce) a
 * Covault setup, with secrets constitutionally excluded.
 *
 * Built as an ALLOWLIST — fields are picked one by one, never "settings
 * minus the secret ones" — so a future secret field can't leak by being
 * forgotten here. Out by design: the PAT, API keys, backend sessions,
 * the device id. MCP server configs are included but their env values
 * (a favourite place for tokens) are masked.
 */
import type { CovaultSettings } from "../settings";
import type { CovaultManifest } from "./manifest";

export const EXPORT_VERSION = 1;

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
      author: { name: settings.author.name, email: settings.author.email },
      llm: { provider: settings.llm.provider, model: settings.llm.model },
      sync: { auto: settings.sync.auto, intervalMinutes: settings.sync.intervalMinutes },
      ask: {
        requireApproval: settings.ask.requireApproval,
        mcpServers: redactMcpConfig(settings.ask.mcpServers),
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

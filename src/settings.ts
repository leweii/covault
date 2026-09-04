/**
 * Covault settings model.
 *
 * Secret fields (deviceId, githubToken, githubApp.connections, llmKeys)
 * are never written to data.json — they live in the per-device secret
 * store outside the vault (see config/secretStore.ts). Everything else is
 * plain machine state that is safe to sync with the vault.
 */

export interface GitHubAppInstallation {
  id: number;
  accountLogin: string;
}

export interface GitHubAppConnection {
  /** Backend session id — pairs with deviceId, treat as a secret. */
  sessionId: string;
  /** GitHub login of the user who authorized. */
  login: string;
  installations: GitHubAppInstallation[];
}

export type AuthMethod = "githubApp" | "pat";

/** One shared knowledge library: a vault subfolder backed by its own repo.
 *  (M3 moved this list into .covault/covault.json so it propagates.) */
export interface SharedRepoSetting {
  /** Vault-relative folder path, e.g. "teams/platform-kb". */
  path: string;
  url: string;
  branch: string;
}

/** Ask's home: its own OS window, or a pane inside Obsidian. */
export type AskOpenIn = "window" | "split";

export interface CovaultSettings {
  authMethod: AuthMethod;
  /** PAT fallback mode (secret). */
  githubToken: string;
  /** Per-device id, half of the backend device binding (secret). */
  deviceId: string;
  /** GitHub App connections (secret — carry backend session ids). */
  githubApp: { connections: GitHubAppConnection[] };

  /** An OpenAI-compatible endpoint the user runs or pays for themselves —
   *  a local server, a gateway, or a model pi-ai's registry doesn't carry.
   *  Its key lives in llmKeys under "custom", like any other provider. */
  customLlm: {
    /** Base URL, e.g. https://openrouter.ai/api/v1 or http://localhost:1234/v1. */
    baseUrl: string;
    /** Model id exactly as that endpoint names it. */
    model: string;
    /** Whether the model accepts images; pi-ai drops them silently if not. */
    vision: boolean;
  };

  /** Selected LLM provider/model (pi-ai provider id + model id), plus
   *  user-authored rules appended to the conflict-merge system prompt. */
  llm: { provider: string; model: string };
  /** API keys keyed by pi-ai provider id (secret). */
  llmKeys: Record<string, string>;

  sync: {
    auto: boolean;
    intervalMinutes: number;
  };

  repos: SharedRepoSetting[];

  /** Commit identity ("who saved this"). Empty → derived from the login. */
  author: { name: string; email: string };

  /** Ask's agent behavior. requireApproval=false is the
   *  dangerously-skip-permissions mode: commands, connected services and
   *  note edits run without asking. MCP servers are opt-in by config.
   *  cliHints is free text listing extra command-line tools (and how to
   *  use them here) that detection can't guess — it joins the detected
   *  inventory in the agent's system prompt. */
  ask: {
    requireApproval: boolean;
    mcpServers: string;
    cliHints: string;
    /** Height in px the user dragged the Ask composer to. 0 = follow the
     *  text. Device-local taste, so it is deliberately not part of an
     *  exported configuration. */
    composerHeight: number;
    /** Where opening Ask puts it: "window" is a popout parked on the right
     *  of the screen, "split" is a pane beside the note. Which one is
     *  right depends on the screen in front of you — one monitor and the
     *  split wins, two and the window does — so like composerHeight this
     *  is per-device and stays out of an exported configuration. */
    openIn: AskOpenIn;
  };

  /** Maintain AGENTS.md/CLAUDE.md blocks + an Agent Skill so AI coding
   *  assistants working in this vault discover the libraries on their own. */
  announceToAgents: boolean;

  /** Add network-level detail (request sizes, timings) to the always-on
   *  operations log. Off by default: only useful while chasing a bug. */
  debugMode: boolean;

  /** Personal knowledge base: the vault root synced to a personal repo. */
  mainRepo: { url: string; branch: string } | null;
  /**
   * A personal KB setup that hasn't finished yet — set the moment the user
   * commits to a target, cleared once `mainRepo` is saved. Setup can run
   * for many minutes (a big attachment backlog) and outlive a reload; on
   * the next load this is what lets it resume on its own instead of
   * sending the user back through the picker.
   */
  pendingMainKb: { url: string; branch: string; mode: "create" | "adopt" } | null;
}

export const DEFAULT_SETTINGS: CovaultSettings = {
  authMethod: "githubApp",
  githubToken: "",
  deviceId: "",
  githubApp: { connections: [] },
  customLlm: { baseUrl: "", model: "", vision: false },
  llm: { provider: "anthropic", model: "" },
  llmKeys: {},
  sync: { auto: true, intervalMinutes: 10 },
  repos: [],
  author: { name: "", email: "" },
  ask: { requireApproval: true, mcpServers: "", cliHints: "", composerHeight: 0, openIn: "window" },
  announceToAgents: true,
  debugMode: false,
  mainRepo: null,
  pendingMainKb: null,
};

/**
 * Is GitHub access configured at all? Nothing that touches a repo —
 * cloning a library, importing a configuration — can work before this is
 * true, so callers check it before starting rather than failing per repo.
 *
 * A PAT sitting in settings while the GitHub App is the selected method
 * does not count: that token is not what the engine would reach for.
 */
export function isSignedIn(settings: CovaultSettings): boolean {
  return settings.authMethod === "pat"
    ? settings.githubToken.trim().length > 0
    : settings.githubApp.connections.length > 0;
}

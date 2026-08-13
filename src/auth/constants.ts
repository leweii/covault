/**
 * GitHub App + backend (zhiyu-sync) constants.
 *
 * The backend serves multiple apps; Covault's callback URL is
 * `<BACKEND_BASE>/auth/covault/callback` (register exactly this on the
 * GitHub App).
 */
export const BACKEND_BASE = "https://sync.zhiyu-online.com";
/** GitHub's slug for the app (name "Covault-CT" → install URL). The
 *  backend's internal slug/callback path stays "covault". */
export const APP_SLUG = "covault-ct";

/** OAuth client id — public (appears in authorize URLs), safe to embed.
 *  App ID 4577134. */
export const CLIENT_ID = "Iv23li7tzv2hyf7tLjuC";

/** obsidian:// protocol action the backend deep-links back to. */
export const PROTOCOL_ACTION = "covault";

/**
 * OAuth authorize URL — the Connect entry point. Unlike `installations/new`,
 * this always issues a `code` to the callback regardless of whether the app
 * is already installed, so it works for reconnects too.
 */
export function authorizeUrl(state: string): string {
  const p = new URLSearchParams({ client_id: CLIENT_ID, state });
  return `https://github.com/login/oauth/authorize?${p.toString()}`;
}

/** Browser URL to install the app on a new account/org (guidance flow). */
export function installUrl(state?: string): string {
  const base = `https://github.com/apps/${APP_SLUG}/installations/new`;
  return state ? `${base}?state=${encodeURIComponent(state)}` : base;
}

/** Page where a user manages/uninstalls the app for an account. */
export function manageInstallUrl(): string {
  return `https://github.com/settings/installations`;
}

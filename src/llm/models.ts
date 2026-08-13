/**
 * pi-ai model registry wired to Covault's settings-backed key storage.
 *
 * `builtinModels()` registers every provider pi-ai ships (Anthropic,
 * OpenAI, Google, Groq, OpenRouter, OpenAI-compatible endpoints, …); the
 * injected CredentialStore resolves each provider's key from the
 * per-device secret store, so keys never touch data.json.
 */
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  MutableModels,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export interface KeyHost {
  getKey(providerId: string): string | undefined;
  setKey(providerId: string, key: string | undefined): Promise<void>;
  listKeyedProviders(): string[];
}

/**
 * CredentialStore over the plugin's secret store. Only api_key credentials
 * are persisted; provider OAuth flows (Copilot, Codex subscriptions) are
 * out of scope for now and their credentials are held in memory only.
 */
class SettingsCredentialStore implements CredentialStore {
  private transient = new Map<string, Credential>();

  constructor(private host: KeyHost) {}

  async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
    const key = this.host.getKey(providerId);
    if (key) return { type: "api_key", key };
    return this.transient.get(providerId);
  }

  async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const infos: CredentialInfo[] = this.host
      .listKeyedProviders()
      .map((providerId) => ({ providerId, type: "api_key" }));
    for (const [providerId, cred] of this.transient) {
      if (!infos.some((i) => i.providerId === providerId)) {
        infos.push({ providerId, type: cred.type });
      }
    }
    return infos;
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const next = await fn(await this.read(providerId, options));
    if (!next) {
      this.transient.delete(providerId);
      await this.host.setKey(providerId, undefined);
    } else if (next.type === "api_key") {
      this.transient.delete(providerId);
      await this.host.setKey(providerId, next.key ?? "");
    } else {
      this.transient.set(providerId, next);
    }
    return next;
  }

  async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
    this.transient.delete(providerId);
    await this.host.setKey(providerId, undefined);
  }
}

export function buildModels(host: KeyHost): MutableModels {
  return builtinModels({ credentials: new SettingsCredentialStore(host) });
}

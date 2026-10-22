/**
 * Agent construction shared by the automation runner and the setup
 * conversation: the model comes from the plugin's AI settings, requests
 * go through the instrumented transport (a failed call keeps its cause —
 * proxy, certificate, DNS — instead of the SDK's bare "Connection
 * error."), and every run has a turn budget.
 */
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { contentText, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { createTransportProbe, describeError, explainModelError, type DiagnoseFn, type TransportProbe } from "../llm/transport";

export interface ModelDeps {
  models: MutableModels;
  getSelection: () => { provider: string; model: string };
  hasKey: (provider: string) => boolean;
  onTransport?: (line: string, failed: boolean) => void;
  diagnose?: DiagnoseFn;
}

export function modelReady(deps: ModelDeps): boolean {
  const { provider, model } = deps.getSelection();
  return !!provider && !!model && deps.hasKey(provider);
}

export function resolveModel(deps: ModelDeps): Model<string> {
  const { provider, model: id } = deps.getSelection();
  if (!provider || !id || !deps.hasKey(provider)) {
    throw new Error("No AI model is set up — choose a provider, model and API key in Settings → Covault → AI engine.");
  }
  const model = deps.models.getModel(provider, id);
  if (!model) throw new Error(`Model ${provider}/${id} is not available — pick one in Settings.`);
  return model;
}

export interface BuiltAgent {
  agent: Agent;
  probe: TransportProbe;
  /** Turns used so far; the budget stops the loop at a turn boundary. */
  turns: () => number;
}

export function buildAgent(
  deps: ModelDeps,
  opts: { systemPrompt: string; tools: AgentTool[]; maxTurns: number },
): BuiltAgent {
  const probe = createTransportProbe(
    (line, failed) => deps.onTransport?.(line, failed),
    undefined,
    (url) => deps.diagnose?.(url) ?? Promise.resolve(null),
  );
  let turns = 0;
  const agent = new Agent({
    initialState: { systemPrompt: opts.systemPrompt, model: resolveModel(deps), tools: opts.tools },
    streamFn: (model, context, options) => {
      try {
        return deps.models.streamSimple(model, context, { ...options, fetch: probe.fetch });
      } catch (e) {
        throw new Error(describeError(e), { cause: e });
      }
    },
    // Stop at a turn boundary, not by abort: an abort mid-request would
    // throw away the answer the model was in the middle of writing.
    finishTurn: () => {
      turns += 1;
      return turns >= opts.maxTurns ? { action: "end" } : undefined;
    },
    identity: { attribution: { name: "Covault", url: "https://github.com/leweii/covault" } },
  });
  return { agent, probe, turns: () => turns };
}

/** The last assistant message's text — the agent's answer or report. */
export function finalText(agent: Agent): string {
  for (let i = agent.state.messages.length - 1; i >= 0; i--) {
    const m = agent.state.messages[i] as { role?: string; content?: unknown };
    if (m.role === "assistant") return contentText(m.content as never).trim();
  }
  return "";
}

/** A failed run's error, with what the transport saw appended. */
export function runError(built: BuiltAgent, e?: unknown): string | null {
  const reported = e !== undefined ? describeError(e) : built.agent.state.errorMessage;
  if (!reported) return null;
  return explainModelError(reported, built.probe.lastFailure);
}

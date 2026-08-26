/**
 * The custom provider exists so a model the bundled registries don't carry
 * — or an endpoint only this user can reach — is still selectable.
 */
import { describe, expect, it } from "vitest";
import { customProvider, CUSTOM_PROVIDER_ID } from "../src/llm/models";

describe("customProvider", () => {
  const config = { baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-v4-flash-vision-exp", vision: true };

  it("exposes exactly the one model the user named", () => {
    const p = customProvider(config);
    expect(p.getModels().map((m) => m.id)).toEqual([config.model]);
    expect(p.getModels()[0]?.provider).toBe(CUSTOM_PROVIDER_ID);
    expect(p.getModels()[0]?.baseUrl).toBe(config.baseUrl);
  });

  it("declares image support only when the user says the model has it", () => {
    expect(customProvider(config).getModels()[0]?.input).toEqual(["text", "image"]);
    expect(customProvider({ ...config, vision: false }).getModels()[0]?.input).toEqual(["text"]);
  });

  it("offers no model until one is named, so nothing half-configured is selectable", () => {
    expect(customProvider({ ...config, model: "" }).getModels()).toEqual([]);
  });

  /** Cost is unknown for an arbitrary endpoint; zero beats inventing a
   *  number that would show up as a real figure in the chat footer. */
  it("reports no cost rather than a guess", () => {
    expect(customProvider(config).getModels()[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

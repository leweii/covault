import { describe, expect, it } from "vitest";
import { buildConfigExport, redactMcpConfig } from "../src/covault/exportConfig";
import { DEFAULT_SETTINGS, type CovaultSettings } from "../src/settings";
import type { CovaultManifest } from "../src/covault/manifest";

function settings(): CovaultSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    githubToken: "ghp_SECRET",
    deviceId: "DEVICE_SECRET",
    githubApp: { connections: [{ sessionId: "SESSION_SECRET", login: "jakob", installations: [] }] },
    llmKeys: { anthropic: "sk-SECRET" },
    baseOrg: "ct-kb",
    author: { name: "Jakob", email: "j@x.com" },
    llm: { provider: "anthropic", model: "claude-sonnet-5" },
    ask: {
      requireApproval: false,
      mcpServers: '{"mcpServers": {"jira": {"command": "npx", "env": {"JIRA_TOKEN": "tok_SECRET"}}}}',
      cliHints: "mycli — internal deploy tool",
    },
    mainRepo: { url: "https://github.com/ct-kb/personal-kb-jakob.git", branch: "main" },
  };
}

const manifest: CovaultManifest = {
  version: 1,
  scope: "vault",
  include: ["notes"],
  repos: [
    { path: "Z01/team-ccp-kb", url: "https://github.com/ct-kb/team-ccp-kb.git", branch: "main", description: "CCP" },
    { path: "Z01/team-oms-kb", url: "https://github.com/ct-kb/team-oms-kb.git", branch: "main" },
  ],
};

describe("buildConfigExport", () => {
  it("carries every setting a teammate needs to reproduce the setup", () => {
    const out = JSON.parse(JSON.stringify(buildConfigExport(settings(), manifest)));
    expect(out.covaultExport).toBe(1);
    expect(out.settings.baseOrg).toBe("ct-kb");
    expect(out.settings.llm).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(out.settings.ask.requireApproval).toBe(false);
    expect(out.settings.personalKb.url).toContain("personal-kb-jakob");
    expect(out.personalKbScope).toEqual({ scope: "vault", include: ["notes"] });
    expect(out.libraries).toHaveLength(2);
    expect(out.libraries[0].description).toBe("CCP");
    expect(out.libraries[1]).not.toHaveProperty("description");
  });

  it("never leaks a secret, even via the MCP env", () => {
    const text = JSON.stringify(buildConfigExport(settings(), manifest));
    for (const secret of ["ghp_SECRET", "DEVICE_SECRET", "SESSION_SECRET", "sk-SECRET", "tok_SECRET"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("JIRA_TOKEN"); // the key survives, the value doesn't
    expect(text).toContain("«redacted»");
  });
});

describe("redactMcpConfig", () => {
  it("masks env values in every config shape", () => {
    expect(redactMcpConfig('[{"name": "a", "command": "x", "env": {"T": "s3cret"}}]')).not.toContain("s3cret");
    expect(redactMcpConfig('{"direct": {"url": "https://x", "env": {"K": "v"}}}')).not.toContain('"v"');
  });

  it("passes empty and invalid JSON through untouched", () => {
    expect(redactMcpConfig("")).toBe("");
    expect(redactMcpConfig("{half-typed")).toBe("{half-typed");
  });
});

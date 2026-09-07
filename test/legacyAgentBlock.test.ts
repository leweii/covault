import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { purgeLegacyAgentBlock, removeManagedBlock } from "../src/covault/legacyAgentBlock";

const START = "<!-- >>> covault managed — do not edit between markers <<< -->";
const END = "<!-- <<< covault managed >>> -->";

/** A file as an old plugin version would have left it. */
function withBlock(before = "", after = ""): string {
  return `${before}${START}\n## Team knowledge libraries\n\n- a-kb — \`a-kb/\`\n${END}\n${after}`;
}

let vault: string;

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "covault-legacy-block-"));
});
afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
});

describe("removeManagedBlock", () => {
  it("keeps the user's own instructions and drops only ours", () => {
    const file = path.join(vault, "AGENTS.md");
    fs.writeFileSync(file, withBlock("# My own rules\nBe terse.\n\n", "\nNever guess.\n"));
    removeManagedBlock(file);
    const rest = fs.readFileSync(file, "utf8");
    expect(rest).toContain("Be terse.");
    expect(rest).toContain("Never guess.");
    expect(rest).not.toContain("covault managed");
    expect(rest).not.toContain("Team knowledge libraries");
  });

  it("deletes the file when it held nothing but our block", () => {
    const file = path.join(vault, "AGENTS.md");
    fs.writeFileSync(file, withBlock());
    removeManagedBlock(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("leaves a file with no block of ours untouched", () => {
    const file = path.join(vault, "CLAUDE.md");
    fs.writeFileSync(file, "# Mine\nNothing of theirs in here.\n");
    removeManagedBlock(file);
    expect(fs.readFileSync(file, "utf8")).toBe("# Mine\nNothing of theirs in here.\n");
  });

  it("is a no-op on a file that isn't there", () => {
    expect(() => removeManagedBlock(path.join(vault, "AGENTS.md"))).not.toThrow();
  });

  it("ignores a lone end marker rather than cutting from the top", () => {
    const file = path.join(vault, "AGENTS.md");
    fs.writeFileSync(file, `# Mine\n${END}\nStill mine.\n`);
    removeManagedBlock(file);
    expect(fs.readFileSync(file, "utf8")).toContain("# Mine");
  });
});

describe("purgeLegacyAgentBlock", () => {
  it("sweeps both vault-root files and stays idempotent", () => {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      fs.writeFileSync(path.join(vault, name), withBlock("Keep me.\n\n"));
    }
    purgeLegacyAgentBlock(vault);
    purgeLegacyAgentBlock(vault);
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const rest = fs.readFileSync(path.join(vault, name), "utf8");
      expect(rest).toContain("Keep me.");
      expect(rest).not.toContain("covault managed");
    }
  });

  it("touches nothing in a vault that never had the feature", () => {
    purgeLegacyAgentBlock(vault);
    expect(fs.readdirSync(vault)).toEqual([]);
  });
});

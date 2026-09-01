// Lint setup that mirrors the Obsidian plugin review checks: the
// obsidianmd plugin's recommended rules (popout-window compatibility,
// createEl helpers, deprecated API) plus typed typescript-eslint, which
// is what catches the unnecessary assertions and floating promises.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  { ignores: ["main.js", "node_modules/**", "test/**", "*.mjs", "*.cjs"] },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
);

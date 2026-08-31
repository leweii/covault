# Covault

Team knowledge base client for Obsidian. Share, consume, and evolve your team's knowledge through silently synced shared folders — an LLM agent handles all the git plumbing so you never have to think about commits, branches, or merges.

Built for teams where most members are **not** engineers: the UI speaks knowledge-base language (share / update / resolve), never git.

## What it does

- **Team libraries** — subfolders in your vault backed by your organization's GitHub repos. Add one from a picker, or share any folder as a new library with one right-click. Everything syncs silently in the background.
- **Personal knowledge base** — back up your own notes to a personal repo in your team's org, **opt-in**: everything stays private until you mark a note or folder "Share to my knowledge base".
- **AI conflict resolution** — when you and a teammate edit the same line, an LLM (your choice of provider) merges the two versions. High-confidence merges apply silently; anything uncertain opens a three-pane review UI where you pick a side, accept the AI's merge, or edit by hand.
- **History & diff** — right-click any synced note to see who changed what, when, with inline diffs.
- **Side panel** — live view of what you share and which libraries you pull, with sync state at a glance.

## Setup

1. Enable the plugin (desktop only).
2. Settings → Covault → **Connect** to GitHub (one click in the browser; a personal access token also works).
3. Add a shared library (pick the organization in the dialog), or set up your personal knowledge base.
4. Optionally configure an AI provider (Anthropic, OpenAI, DeepSeek, Google, and 20+ more) for conflict handling and summaries.

## Security notes

- All credentials (GitHub tokens, LLM API keys) are stored **outside your vault** in your OS user-config directory — they never sync with your notes.
- GitHub access uses a GitHub App with short-lived, repository-scoped tokens minted by a backend; no long-lived token is stored on disk.
- Your notes go only to the GitHub repos you connect and, for conflict resolution, to the LLM provider you configure.

## Requirements

- Desktop Obsidian (the plugin is `isDesktopOnly`).
- A GitHub account; for team features, a GitHub organization.

## License

MIT

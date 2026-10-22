/**
 * Community plugins Covault recommends alongside itself — the guide in
 * the panel and in Settings walks the user through installing them.
 *
 * To recommend another plugin, add an entry: `id` must be the plugin's id
 * in the official community list (obsidian-releases/community-plugins.json),
 * which is what the install link and the installed check key on.
 */
export interface RecommendedPlugin {
  id: string;
  name: string;
  /** One line on what it adds to a Covault vault. */
  description: string;
}

export const RECOMMENDED_PLUGINS: RecommendedPlugin[] = [
  {
    id: "realclaudian",
    name: "Claudian",
    description: "Claude Code and other coding agents inside your vault — ask them about your knowledge libraries.",
  },
  {
    id: "knowlery",
    name: "Knowlery",
    description: "A warm review space for what you and your team have written down.",
  },
];

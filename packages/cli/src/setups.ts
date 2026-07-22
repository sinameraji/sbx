/**
 * Canned `--setup` snippets the CLI can wire for you (`--opencode` today; more
 * agents later). Kept apart from the wizard so flag and wizard paths share one
 * copy. examples/agent.mjs carries an independent copy on purpose — a
 * standalone zero-import example can't reach CLI internals.
 */

// Verified OpenCode wiring (same as examples/agents.sh): install, then point its
// openrouter provider at the egress gateway env the daemon injects.
export const OPENCODE_SETUP =
  `npm i -g opencode-ai >/dev/null 2>&1 && mkdir -p ~/.config/opencode && ` +
  `printf '{"provider":{"openrouter":{"options":{"baseURL":"%s/v1","apiKey":"%s"}}}}' ` +
  `"$OPENROUTER_BASE_URL" "$OPENROUTER_API_KEY" > ~/.config/opencode/opencode.json`;

/** Whether an image (undefined = the node-capable default) can run `npm i -g`. */
export function nodeCapableImage(image: string | undefined): boolean {
  return image === undefined || /node|hotcell-base/.test(image);
}

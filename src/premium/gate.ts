/**
 * Premium license gate.
 * Reads PRO_LICENSE dynamically from process.env at call time — not cached.
 * This allows the license to be set after server start without restart.
 */

/**
 * Returns true if a valid Pro license is currently set in the environment.
 * A valid key starts with "CPK-" and is at least 8 characters long.
 */
export function isPro(): boolean {
  const key = process.env.PRO_LICENSE;
  return Boolean(key && key.length >= 8 && key.startsWith("CPK-"));
}

/**
 * Throws if no valid Pro license is configured.
 * Call at the start of every Pro-gated tool handler.
 *
 * @param toolName - The name of the tool being called, used in the error message.
 */
export function requirePro(toolName: string): void {
  if (!isPro()) {
    throw new Error(
      `[${toolName}] requires a Pro license. ` +
        `Get one at https://craftpipe.dev/products/devpilot-mcp — ` +
        `then set PRO_LICENSE=<your-key> in your environment.`
    );
  }
}

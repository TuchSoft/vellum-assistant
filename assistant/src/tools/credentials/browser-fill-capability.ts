/**
 * Canonical capability key for browser-based credential fills.
 *
 * This decouples credential logging from any specific tool name so a browser
 * fill is identified by capability even when no `browser_fill_credential`
 * tool is registered in the manifest.
 */
export const BROWSER_FILL_CAPABILITY = "assistant_browser_fill_credential";

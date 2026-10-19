/**
 * Shared formatters for `assistant db` subcommands. Inlined here (rather than
 * importing from a sibling command) so the `db` directory is self-contained
 * and the formatting choices stay consistent across its subcommands.
 */

/** Format a byte count as a human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Format a number with thousands separators (1234567 → "1,234,567"). */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Parse a human-readable window string into milliseconds.
 *
 * Supported formats:
 * - "10 s"  → 10_000 ms
 * - "1 m"   → 60_000 ms
 * - "1 h"   → 3_600_000 ms
 *
 * Defaults to seconds if no unit suffix is provided.
 */
export function parseWindow(window: string): number {
  const trimmed = window.trim();
  const match = trimmed.match(/^(\d+)\s*(s|m|h)?$/);

  if (!match) {
    throw new Error(`Invalid window format: "${window}". Expected "N s", "N m", or "N h".`);
  }

  const value = Number.parseInt(match[1], 10);
  const unit = match[2] ?? "s";

  const multipliers: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };
  return value * multipliers[unit];
}

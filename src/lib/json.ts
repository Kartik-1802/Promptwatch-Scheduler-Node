/** SQLite has no native array/JSON column type, so list fields (Monitor.models,
 * Schedule.days) are stored as JSON-encoded strings — these helpers keep the
 * parse/stringify at the edges instead of scattered through the codebase. */

export function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function parseDayArray(value: string | null | undefined): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  } catch {
    return [];
  }
}

/** Monitor.models is stored as a JSON-encoded string — this helper keeps the
 * parsing at the edges instead of scattered through the codebase. */

export function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

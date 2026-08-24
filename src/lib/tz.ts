/** IANA timezone helpers. Node has no direct zoneinfo-attached datetime like Python,
 * so we extract wall-clock parts via Intl and work in minutes-since-Monday-00:00. */

const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export interface ZonedParts {
  weekday: number; // 0=Mon .. 6=Sun, matches Python's date.weekday()
  hour: number;
  minute: number;
}

export function partsAt(date: Date, timezone: string): ZonedParts {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const part of formatted) map[part.type] = part.value;

  return {
    weekday: WEEKDAY_INDEX[map.weekday] ?? 0,
    hour: parseInt(map.hour, 10) % 24, // some locales render midnight as "24"
    minute: parseInt(map.minute, 10),
  };
}

export function availableTimezones(): string[] {
  return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

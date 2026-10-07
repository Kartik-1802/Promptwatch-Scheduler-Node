/** Preserve the start across refreshes; OFF ends the current ON period. */
export function activityStart(previous: { active: boolean; activeSince: Date | null } | null, active: boolean, now = new Date()): Date | null {
  return active ? (previous?.active ? previous.activeSince ?? now : now) : null;
}

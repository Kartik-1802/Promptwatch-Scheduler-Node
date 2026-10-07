/** Calendar-date arithmetic: reset dates are exclusive; one run per active date. */
export const RESPONSE_LIMIT = 10_000;
export function dateKey(now: Date, timezone: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => p.find(x => x.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function addDays(key: string, days: number): string {
  return new Date(Date.parse(key + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
export function weekday(key: string): number { return (new Date(key + 'T12:00:00Z').getUTCDay() + 6) % 7; }
export function responsePeriods(now: Date, timezone: string, billing?: { periodFrom: Date; periodTo: Date } | null) {
  const today = dateKey(now, timezone);
  const [y, m, d] = today.split('-').map(Number);
  const month = d >= 6 ? m - 1 : m - 2;
  let start = new Date(Date.UTC(y, month, 6)).toISOString().slice(0, 10);
  let end = new Date(Date.UTC(y, month + 1, 6)).toISOString().slice(0, 10);
  let from = midnight(start, timezone), to = midnight(end, timezone);
  if (billing && billing.periodFrom <= now && billing.periodTo > billing.periodFrom) {
    from = new Date(billing.periodFrom); to = new Date(billing.periodTo);
    // Keep the provider's known reset time across rollover, even before the next sync.
    while (to <= now) {
      from = new Date(to);
      to = new Date(to); to.setUTCMonth(to.getUTCMonth() + 1);
    }
    start = dateKey(from, timezone); end = dateKey(to, timezone);
  }
  const monday = addDays(today, -weekday(today));
  return { today, start, end, periodStartAt: from.toISOString(), resetAt: to.toISOString(), weekStart: monday < start ? start : monday, weekEnd: addDays(monday, 7) > end ? end : addDays(monday, 7) };
}
/** Resolve local midnight to UTC, including offset changes across months. */
export function midnight(key: string, timezone: string): Date {
  const target = Date.parse(key + 'T00:00:00Z');
  let guess = target;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map(x => [x.type, x.value]));
    const actual = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const delta = target - actual;
    if (!delta) break;
    guess += delta;
  }
  return new Date(guess);
}
export type PlanBlock = { startDay: number; startTime: string; endDay: number; endTime: string; trigger: string };
export type PlanMonitor = { active: boolean; promptCount: number | null; models: string[]; overrideUntil?: string | null };
const minute = (day: number, time: string) => day * 1440 + Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
function scheduledOn(blocks: PlanBlock[], at: number): boolean {
  const open = blocks.find(b => {
    const start = minute(b.startDay, b.startTime), end = minute(b.endDay, b.endTime);
    return end > start ? at >= start && at < end : at >= start || at < end;
  });
  return open ? open.trigger !== 'off_on' : blocks.every(b => b.trigger === 'off_on');
}
/** Any ON portion of a day counts once, including overnight and inverted blocks. */
export function runOnDate(m: PlanMonitor, blocks: PlanBlock[], key: string, timezone: string, automated = true): boolean {
  if (!blocks.length || !automated) return m.active;
  const start = weekday(key) * 1440;
  const points = new Set([0]);
  for (const b of blocks) {
    for (const n of [minute(b.startDay, b.startTime), minute(b.endDay, b.endTime)]) {
      if (n >= start && n < start + 1440) points.add(n - start);
    }
  }
  let holdEnd = -1;
  if (m.overrideUntil) {
    const until = new Date(m.overrideUntil);
    const holdDate = dateKey(until, timezone);
    if (key < holdDate) return m.active;
    if (key === holdDate) {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(until);
      holdEnd = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
      points.add(holdEnd);
    }
  }
  return [...points].some(p => p < holdEnd ? m.active : scheduledOn(blocks, start + p));
}
export function planResponses(monitors: PlanMonitor[], blocks: PlanBlock[], start: string, end: string, timezone: string, automated = true, respectHolds = false): number {
  let total = 0;
  for (let date = start; date < end; date = addDays(date, 1)) {
    for (const m of monitors) {
      if (runOnDate(respectHolds ? m : { ...m, overrideUntil: null }, blocks, date, timezone, automated)) total += Math.max(0, m.promptCount ?? 0) * m.models.length;
    }
  }
  return total;
}
export function predictionAlert(used: number | null, predicted: number) {
  return used !== null && used > 0 && (predicted === 0 || used / predicted >= 0.7);
}

/** Any partial remaining day counts as one full day; response counts round up too. */
export function remainingPlan(weekly: number, now: Date, resetAt: string) {
  const days = Math.max(0, Math.ceil((Date.parse(resetAt) - now.getTime()) / 86400000));
  return { days, responses: Math.ceil(weekly * days / 7) };
}

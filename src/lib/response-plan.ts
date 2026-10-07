/** Response planning: one expected run per 24 hours, rounded up per active window. */
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
const WEEK_MINUTES = 7 * 1440;
function blockDuration(block: PlanBlock) {
  const start = minute(block.startDay, block.startTime);
  const end = minute(block.endDay, block.endTime);
  return end > start ? end - start : WEEK_MINUTES - start + end;
}
/** Round each block up to days; ON blocks add runs, inverted OFF blocks subtract from seven. */
export function expectedWeeklyRuns(blocks: PlanBlock[]): number {
  if (!blocks.length) return 7;
  if (blocks.every(b => b.trigger === 'off_on')) {
    const offDays = blocks.reduce((sum, block) => sum + Math.ceil(blockDuration(block) / 1440), 0);
    return Math.max(0, 7 - offDays);
  }
  // Mixed triggers default OFF outside blocks, as the scheduler does.
  return blocks.filter(b => b.trigger !== 'off_on').reduce((runs, block) => runs + Math.ceil(blockDuration(block) / 1440), 0);
}
export function weeklyResponses(monitors: PlanMonitor[], blocks: PlanBlock[], automated = true): number {
  return projectFormula(monitors, blocks, automated).weekly;
}
export function predictionAlert(used: number | null, predicted: number) {
  return used !== null && predicted > 0 && used / predicted > 0.7;
}

/** Any partial remaining day counts as one full day; response counts round up too. */
export function remainingPlan(weekly: number, now: Date, resetAt: string) {
  const days = Math.max(0, Math.ceil((Date.parse(resetAt) - now.getTime()) / 86400000));
  return { days, responses: Math.ceil(weekly * days / 7) };
}

export type FormulaOverride = { projectId: string; baseResponses: number | null; runsPerWeek: number | null; weeksPerMonth: number };
export function projectFormula(monitors: PlanMonitor[], blocks: PlanBlock[], automated = true, override?: FormulaOverride) {
  const scheduled = blocks.length > 0 && automated;
  const automaticBase = monitors.reduce((sum, m) => sum + (scheduled || m.active ? Math.max(0, m.promptCount ?? 0) * m.models.length : 0), 0);
  const daily = monitors.reduce((sum, m) => sum + (m.active ? Math.max(0, m.promptCount ?? 0) * m.models.length : 0), 0);
  const automaticRuns = blocks.length && automated ? expectedWeeklyRuns(blocks) : 7;
  const baseResponses = override?.baseResponses ?? automaticBase;
  const runsPerWeek = override?.runsPerWeek ?? automaticRuns;
  const weeksPerMonth = override?.weeksPerMonth ?? 4;
  return { automaticBase, automaticRuns, baseResponses, runsPerWeek, weeksPerMonth, scheduled,
    daily, weekly: baseResponses * runsPerWeek, monthly: baseResponses * runsPerWeek * weeksPerMonth,
    custom: !!override,
    baseCustom: override?.baseResponses !== null && override?.baseResponses !== undefined,
    runsCustom: override?.runsPerWeek !== null && override?.runsPerWeek !== undefined,
  };
}

/** Window evaluation + the background loop that flips monitors on and off.
 * Mirrors scheduler.py. Runs inside the standalone worker process
 * (scripts/worker.ts) via setTimeout recursion — needs a persistent Node
 * process, not serverless/edge. */
import { prisma } from "./db";
import { parseDayArray } from "./json";
import { ApiError, PromptwatchClient } from "./promptwatch";
import { log } from "./store";
import { partsAt } from "./tz";

const RETRY_BACKOFF_MS = 5 * 60 * 1000;

export interface ScheduleLike {
  enabled: boolean;
  days: number[];
  startTime: string;
  endTime: string;
}

/** Schedule.days is stored as a JSON-encoded string — validate and coerce it
 * back to number[] whenever we read a schedule out of the DB. */
export function toScheduleLike(row: { enabled: boolean; days: string; startTime: string; endTime: string } | null): ScheduleLike | null {
  if (!row) return null;
  return { enabled: row.enabled, days: parseDayArray(row.days), startTime: row.startTime, endTime: row.endTime };
}

function parseHHMM(value: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? "");
  if (!match) return fallback;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

/** True when the given weekday/minute-of-day falls inside the schedule's window.
 * Windows where end <= start wrap past midnight; the selected days refer to the
 * day the window opens, so a Fri 22:00-02:00 window stays on until Sat 02:00. */
export function inWindow(schedule: ScheduleLike, weekday: number, minutes: number): boolean {
  const days = schedule.days ?? [];
  if (!days.length) return false;

  const start = parseHHMM(schedule.startTime, 0);
  const end = parseHHMM(schedule.endTime, 24 * 60);

  if (start === end) return days.includes(weekday);
  if (start < end) return days.includes(weekday) && minutes >= start && minutes < end;

  const yesterday = (weekday - 1 + 7) % 7;
  return (days.includes(weekday) && minutes >= start) || (days.includes(yesterday) && minutes < end);
}

/** Desired active state, or null when this monitor isn't under scheduler control. */
export function evaluate(schedule: ScheduleLike | null, weekday: number, minutes: number): boolean | null {
  if (!schedule || !schedule.enabled) return null;
  return inWindow(schedule, weekday, minutes);
}

export function nextTransition(schedule: ScheduleLike | null, timezone: string, horizonMinutes = 8 * 24 * 60) {
  if (!schedule || !schedule.enabled) return null;
  const now = new Date();
  const cur = partsAt(now, timezone);
  const current = inWindow(schedule, cur.weekday, cur.hour * 60 + cur.minute);

  for (let step = 1; step <= horizonMinutes; step++) {
    const probe = new Date(now.getTime() + step * 60_000);
    const p = partsAt(probe, timezone);
    const state = inWindow(schedule, p.weekday, p.hour * 60 + p.minute);
    if (state !== current) {
      return { at: probe.toISOString(), to: current ? "inactive" : "active" };
    }
  }
  return null;
}

let lastTickAt: number | null = null;
export function getLastTickAt() {
  return lastTickAt;
}

export async function tick(force = false, actor = "Scheduler") {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  lastTickAt = Date.now();
  if (!settings?.apiKey) return [];
  if (!settings.schedulerEnabled && !force) return [];

  const parts = partsAt(new Date(), settings.timezone);
  const minutes = parts.hour * 60 + parts.minute;
  const client = new PromptwatchClient(settings.apiKey);
  const changes: Array<{ monitorId: string; active: boolean }> = [];

  const monitors = await prisma.monitor.findMany({ include: { schedule: true } });

  for (const monitor of monitors) {
    const schedule = toScheduleLike(monitor.schedule);
    const desired = evaluate(schedule, parts.weekday, minutes);
    if (desired === null || desired === monitor.active) continue;
    if (!force && monitor.nextRetryAt && monitor.nextRetryAt.getTime() > Date.now()) continue;

    try {
      await client.setMonitorActive(monitor.projectId, monitor.id, desired);
    } catch (err) {
      const apiErr = err as ApiError;
      await prisma.monitor.update({
        where: { id: monitor.id },
        data: { nextRetryAt: new Date(Date.now() + RETRY_BACKOFF_MS) },
      });
      await log(
        "error",
        "apply",
        `Failed to set '${monitor.name}' to ${desired ? "active" : "inactive"}: ${apiErr.message}`,
        { monitorId: monitor.id, projectId: monitor.projectId, code: apiErr.code, user: actor }
      );
      continue;
    }

    await prisma.monitor.update({
      where: { id: monitor.id },
      data: { active: desired, nextRetryAt: null },
    });
    const window = `${monitor.schedule!.startTime}–${monitor.schedule!.endTime}`;
    await log(
      "success",
      "apply",
      `${desired ? "Activated" : "Deactivated"} '${monitor.name}' (window ${window})`,
      { monitorId: monitor.id, projectId: monitor.projectId, user: actor, kind: desired ? "activate" : "deactivate" }
    );
    changes.push({ monitorId: monitor.id, active: desired });
  }

  return changes;
}

let intervalHandle: ReturnType<typeof setTimeout> | null = null;

export function startSchedulerLoop() {
  if (intervalHandle) return; // already running (e.g. hot reload in dev)
  const runOnce = async () => {
    try {
      await tick();
    } catch (err) {
      await log("error", "scheduler", `Tick failed: ${(err as Error).message}`);
    }
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    const seconds = Math.max(10, settings?.tickSeconds ?? 60);
    intervalHandle = setTimeout(runOnce, seconds * 1000);
  };
  runOnce();
}

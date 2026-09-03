/** Window evaluation + the background loop that flips monitors on and off.
 * Mirrors scheduler.py. Runs inside the standalone worker process
 * (scripts/worker.ts) via setTimeout recursion — needs a persistent Node
 * process, not serverless/edge.
 *
 * A block is a single (startDay,startTime) → (endDay,endTime) window within
 * the week — the same day/time-range model as the reference time block
 * scheduler this was built from, just 0-indexed (0=Mon..6=Sun) to match this
 * app's existing weekday convention instead of that file's 1-7. */
import { prisma } from "./db";
import { ApiError, PromptwatchClient } from "./promptwatch";
import { log } from "./store";
import { partsAt } from "./tz";

const RETRY_BACKOFF_MS = 5 * 60 * 1000;
export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface BlockLike {
  startDay: number;
  startTime: string;
  endDay: number;
  endTime: string;
}

export function toBlockLike(row: { startDay: number; startTime: string; endDay: number; endTime: string }): BlockLike {
  return { startDay: row.startDay, startTime: row.startTime, endDay: row.endDay, endTime: row.endTime };
}

function parseHHMM(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? "");
  if (!match) return 0;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

/** Absolute minute within the week (0 = Monday 00:00 .. 10079 = Sunday
 * 23:59) — the same `minutes(day, time)` a block's start/end resolve to. */
function weekMinute(day: number, time: string): number {
  return day * 24 * 60 + parseHHMM(time);
}

function range(block: BlockLike): { start: number; end: number } {
  return { start: weekMinute(block.startDay, block.startTime), end: weekMinute(block.endDay, block.endTime) };
}

export function describeBlock(block: BlockLike): string {
  return `${DAY_NAMES[block.startDay] ?? "?"} ${block.startTime} → ${DAY_NAMES[block.endDay] ?? "?"} ${block.endTime}`;
}

/** True when the given weekday/minute-of-day falls inside the block's window. */
export function inWindow(block: BlockLike, weekday: number, minutes: number): boolean {
  const { start, end } = range(block);
  if (end <= start) return false; // invalid block (shouldn't happen — cleanBlock rejects this at creation)
  const current = weekday * 24 * 60 + minutes;
  return current >= start && current < end;
}

/** Whether two blocks share or touch any moment of the week — used to keep a
 * single monitor's blocks mutually exclusive (see the ScheduleBlock model
 * comment). Touching boundaries count as a conflict, same as the reference. */
export function blocksOverlap(a: BlockLike, b: BlockLike): boolean {
  const ra = range(a), rb = range(b);
  return ra.start <= rb.end && rb.start <= ra.end;
}

/** Desired active state, or null when this monitor isn't under scheduler control
 * (it has no blocks at all). Active whenever ANY block's window is currently open. */
export function evaluate(blocks: BlockLike[], weekday: number, minutes: number): boolean | null {
  if (!blocks.length) return null;
  return blocks.some((b) => inWindow(b, weekday, minutes));
}

export function nextTransition(blocks: BlockLike[], timezone: string, horizonMinutes = 8 * 24 * 60) {
  if (!blocks.length) return null;
  const now = new Date();
  const cur = partsAt(now, timezone);
  const current = evaluate(blocks, cur.weekday, cur.hour * 60 + cur.minute);

  for (let step = 1; step <= horizonMinutes; step++) {
    const probe = new Date(now.getTime() + step * 60_000);
    const p = partsAt(probe, timezone);
    const state = evaluate(blocks, p.weekday, p.hour * 60 + p.minute);
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

  const monitors = await prisma.monitor.findMany({ include: { scheduleBlocks: true } });

  for (const monitor of monitors) {
    const blocks = monitor.scheduleBlocks.map(toBlockLike);
    const desired = evaluate(blocks, parts.weekday, minutes);
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
    const openBlock = blocks.find((b) => inWindow(b, parts.weekday, minutes));
    const window = openBlock ? ` (window ${describeBlock(openBlock)})` : "";
    await log(
      "success",
      "apply",
      `${desired ? "Activated" : "Deactivated"} '${monitor.name}'${window}`,
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

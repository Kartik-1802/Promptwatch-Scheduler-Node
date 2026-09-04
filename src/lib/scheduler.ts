/** Window evaluation + the background loop that flips monitors on and off.
 * Mirrors scheduler.py. Runs inside the standalone worker process
 * (scripts/worker.ts) via setTimeout recursion — needs a persistent Node
 * process, not serverless/edge.
 *
 * A block is a single (startDay,startTime) → (endDay,endTime) window within
 * the week — the same day/time-range model as the reference time block
 * scheduler this was built from, just 0-indexed (0=Mon..6=Sun) to match this
 * app's existing weekday convention instead of that file's 1-7.
 *
 * Blocks belong to a PROJECT: a project's schedule drives every monitor
 * inside it. There is no monitor-level schedule. */
import { prisma } from "./db";
import { ApiError, PromptwatchClient } from "./promptwatch";
import { log } from "./store";
import { partsAt } from "./tz";

const RETRY_BACKOFF_MS = 5 * 60 * 1000;
const WEEK_MINUTES = 7 * 24 * 60;
export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export type Trigger = "on_off" | "off_on";

export interface BlockLike {
  startDay: number;
  startTime: string;
  endDay: number;
  endTime: string;
  trigger: Trigger;
}

export function toBlockLike(row: { startDay: number; startTime: string; endDay: number; endTime: string; trigger: string }): BlockLike {
  return {
    startDay: row.startDay,
    startTime: row.startTime,
    endDay: row.endDay,
    endTime: row.endTime,
    trigger: row.trigger === "off_on" ? "off_on" : "on_off",
  };
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

/** Raw (start, end) week-minutes. end <= start means the block wraps past
 * the end of the week (e.g. Fri 18:00 -> Mon 06:00) rather than being
 * invalid — the week is a loop, not a line. */
function range(block: BlockLike): { start: number; end: number } {
  return { start: weekMinute(block.startDay, block.startTime), end: weekMinute(block.endDay, block.endTime) };
}

/** Every week-minute the block's window covers, wrap-aware — used for the
 * overlap check below. A block can cover at most the whole week. */
function occupiedMinutes(block: BlockLike): Set<number> {
  const { start, end } = range(block);
  const duration = end > start ? end - start : WEEK_MINUTES - start + end;
  const set = new Set<number>();
  for (let i = 0; i < duration; i++) set.add((start + i) % WEEK_MINUTES);
  return set;
}

export function describeBlock(block: BlockLike): string {
  const arrow = block.trigger === "off_on" ? "OFF→ON" : "ON→OFF";
  return `${DAY_NAMES[block.startDay] ?? "?"} ${block.startTime} → ${DAY_NAMES[block.endDay] ?? "?"} ${block.endTime} (${arrow})`;
}

/** True when the given weekday/minute-of-day falls inside the block's window
 * (its start/end days+times, regardless of trigger direction). Wrap-aware:
 * a Fri 18:00 -> Mon 06:00 block is "open" from Friday evening straight
 * through to Monday morning. */
export function inWindow(block: BlockLike, weekday: number, minutes: number): boolean {
  const { start, end } = range(block);
  const current = weekday * 24 * 60 + minutes;
  if (end > start) return current >= start && current < end;
  return current >= start || current < end;
}

/** Whether two blocks share or touch any moment of the week — used to keep a
 * project's blocks mutually exclusive (see the ScheduleBlock model comment).
 * Touching boundaries count as a conflict, same as the reference. */
export function blocksOverlap(a: BlockLike, b: BlockLike): boolean {
  const ob = occupiedMinutes(b);
  for (const m of occupiedMinutes(a)) if (ob.has(m)) return true;
  const ra = range(a), rb = range(b);
  return ra.end === rb.start || rb.end === ra.start;
}

/** Desired active state, or null when this project isn't under scheduler
 * control (it has no blocks at all).
 *
 * Each block dictates a state only while its own window is open — "on_off"
 * wants ON while open, "off_on" wants OFF while open (say, a weekend
 * maintenance window) — and blocks never overlap, so at most one applies at
 * once. Outside every block's window, the schedule falls back to the
 * opposite of whichever single direction every block in the project shares;
 * a project mixing on_off and off_on blocks has no one sensible fallback, so
 * it conservatively defaults to OFF outside all windows. */
export function evaluate(blocks: BlockLike[], weekday: number, minutes: number): boolean | null {
  if (!blocks.length) return null;
  const open = blocks.find((b) => inWindow(b, weekday, minutes));
  if (open) return open.trigger !== "off_on";
  return blocks.every((b) => b.trigger === "off_on");
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

/** Applies every project's schedule to the monitors inside it.
 *
 * Logging contract (see the Logs tab): for each project that needs a change
 * we write one `schedule.attempt`, then one `schedule.applied` (success) or
 * `schedule.failed` (with the API status/code/message) per monitor, then a
 * closing `schedule.completed` or `schedule.incomplete` summary. That means
 * every attempt is traceable end to end even when it half-fails. */
export async function tick(force = false, actor = "Scheduler") {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  lastTickAt = Date.now();
  if (!settings?.apiKey) return [];
  if (!settings.schedulerEnabled && !force) return [];

  const parts = partsAt(new Date(), settings.timezone);
  const minutes = parts.hour * 60 + parts.minute;
  const client = new PromptwatchClient(settings.apiKey);
  const changes: Array<{ monitorId: string; active: boolean }> = [];

  const projects = await prisma.project.findMany({ include: { scheduleBlocks: true } });

  for (const project of projects) {
    const blocks = project.scheduleBlocks.map(toBlockLike);
    const desired = evaluate(blocks, parts.weekday, minutes);
    if (desired === null) continue; // no schedule on this project — left manual

    const monitors = await prisma.monitor.findMany({ where: { projectId: project.id } });
    const pending = monitors.filter(
      (m) => m.active !== desired && (force || !m.nextRetryAt || m.nextRetryAt.getTime() <= Date.now())
    );
    if (!pending.length) continue;

    const openBlock = blocks.find((b) => inWindow(b, parts.weekday, minutes));
    const windowText = openBlock ? describeBlock(openBlock) : "outside every block";
    await log(
      "info",
      "schedule.attempt",
      `Applying '${project.name}' schedule — turning ${desired ? "ON" : "OFF"} ${pending.length} monitor(s) (${windowText})`,
      { projectId: project.id, user: actor }
    );

    let succeeded = 0;
    const failed: string[] = [];

    for (const monitor of pending) {
      try {
        await client.setMonitorActive(monitor.projectId, monitor.id, desired);
      } catch (err) {
        const apiErr = err as ApiError;
        await prisma.monitor.update({
          where: { id: monitor.id },
          data: { nextRetryAt: new Date(Date.now() + RETRY_BACKOFF_MS) },
        });
        failed.push(monitor.name);
        await log(
          "error",
          "schedule.failed",
          `Failed to ${desired ? "activate" : "deactivate"} '${monitor.name}' (${project.name}): ` +
            `${apiErr.message} [HTTP ${apiErr.status}${apiErr.code ? `, code ${apiErr.code}` : ""}] — ` +
            `retrying in ${Math.round(RETRY_BACKOFF_MS / 60000)} min`,
          { monitorId: monitor.id, projectId: project.id, code: apiErr.code, user: actor }
        );
        continue;
      }

      await prisma.monitor.update({
        where: { id: monitor.id },
        data: { active: desired, nextRetryAt: null },
      });
      succeeded++;
      changes.push({ monitorId: monitor.id, active: desired });
      await log(
        "success",
        "schedule.applied",
        `${desired ? "Activated" : "Deactivated"} '${monitor.name}' (${project.name})`,
        { monitorId: monitor.id, projectId: project.id, user: actor, kind: desired ? "activate" : "deactivate" }
      );
    }

    if (failed.length) {
      await log(
        "warn",
        "schedule.incomplete",
        `'${project.name}' schedule incomplete — ${succeeded} succeeded, ${failed.length} failed: ${failed.join(", ")}`,
        { projectId: project.id, user: actor }
      );
    } else {
      await log(
        "success",
        "schedule.completed",
        `'${project.name}' schedule completed — ${succeeded} monitor(s) ${desired ? "activated" : "deactivated"}`,
        { projectId: project.id, user: actor }
      );
    }
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

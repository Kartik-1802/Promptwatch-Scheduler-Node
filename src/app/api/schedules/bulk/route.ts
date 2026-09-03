import { NextRequest, NextResponse } from "next/server";
import { MUTATE_ROLES, requireRole } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { cleanBlock, errorResponse, getSession, ValidationError } from "@/lib/http";
import { buildState } from "@/lib/state";
import { blocksOverlap, describeBlock, tick, toBlockLike } from "@/lib/scheduler";
import { log } from "@/lib/store";

/** Add the same new block to every selected monitor. Each monitor is checked
 * independently — a monitor whose existing blocks would overlap the new one
 * is skipped (not applied to any of them), the rest still get it. */
export async function POST(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const body = await req.json();
    const monitorIds: string[] = (body.monitorIds || []).map(String);
    if (!monitorIds.length) throw new ValidationError("No monitors selected.");

    const monitors = await prisma.monitor.findMany({
      where: { id: { in: monitorIds } },
      include: { scheduleBlocks: true },
    });
    if (monitors.length !== monitorIds.length) {
      throw new ValidationError(`${monitorIds.length - monitors.length} selected monitor(s) are unknown — run a sync first.`);
    }

    const block = cleanBlock(body);
    const skipped: Array<{ monitorId: string; name: string; reason: string }> = [];
    const applied: string[] = [];

    for (const monitor of monitors) {
      const conflict = monitor.scheduleBlocks.map(toBlockLike).find((b) => blocksOverlap(b, block));
      if (conflict) {
        skipped.push({ monitorId: monitor.id, name: monitor.name, reason: `overlaps ${describeBlock(conflict)}` });
        continue;
      }
      await prisma.scheduleBlock.create({
        data: { monitorId: monitor.id, startDay: block.startDay, startTime: block.startTime, endDay: block.endDay, endTime: block.endTime },
      });
      applied.push(monitor.id);
    }

    if (applied.length) {
      await log(
        "info", "schedule",
        `Added block to ${applied.length} monitor(s): ${describeBlock(block)}${skipped.length ? ` (${skipped.length} skipped — overlap)` : ""}`,
        { user: session!.email }
      );
      await tick(true, session!.email);
    }
    return NextResponse.json({ ok: true, applied: applied.length, skipped, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Clear every block from every selected monitor. */
export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const body = await req.json();
    const monitorIds: string[] = (body.monitorIds || []).map(String);
    if (!monitorIds.length) throw new ValidationError("No monitors selected.");

    await prisma.scheduleBlock.deleteMany({ where: { monitorId: { in: monitorIds } } });
    await log("info", "schedule", `Schedule cleared for ${monitorIds.length} monitor(s)`, { user: session!.email });
    await tick(true, session!.email);
    return NextResponse.json({ ok: true, count: monitorIds.length, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

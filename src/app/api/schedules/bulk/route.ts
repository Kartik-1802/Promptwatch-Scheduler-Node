import { NextRequest, NextResponse } from "next/server";
import { MUTATE_ROLES, requireRole } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { cleanSchedule, errorResponse, getSession, ValidationError } from "@/lib/http";
import { buildState } from "@/lib/state";
import { tick } from "@/lib/scheduler";
import { log } from "@/lib/store";

export async function PUT(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const body = await req.json();
    const monitorIds: string[] = (body.monitorIds || []).map(String);
    if (!monitorIds.length) throw new ValidationError("No monitors selected.");

    const known = await prisma.monitor.findMany({ where: { id: { in: monitorIds } }, select: { id: true } });
    if (known.length !== monitorIds.length) {
      throw new ValidationError(`${monitorIds.length - known.length} selected monitor(s) are unknown — run a sync first.`);
    }

    const schedule = cleanSchedule(body);
    // SQLite has no array column type — days is stored as a JSON string.
    const row = { ...schedule, days: JSON.stringify(schedule.days) };
    await prisma.$transaction(
      monitorIds.map((monitorId) =>
        prisma.schedule.upsert({
          where: { monitorId },
          create: { monitorId, ...row },
          update: row,
        })
      )
    );

    const state = schedule.enabled ? "on" : "paused";
    await log(
      "info", "schedule",
      `Schedule ${state} for ${monitorIds.length} monitor(s): ${schedule.startTime}–${schedule.endTime} on ${schedule.days.join(",") || "no days"}`,
      { user: session!.email }
    );
    await tick(true, session!.email);
    return NextResponse.json({ ok: true, count: monitorIds.length, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const body = await req.json();
    const monitorIds: string[] = (body.monitorIds || []).map(String);
    if (!monitorIds.length) throw new ValidationError("No monitors selected.");

    await prisma.schedule.deleteMany({ where: { monitorId: { in: monitorIds } } });
    await log("info", "schedule", `Schedule removed for ${monitorIds.length} monitor(s)`, { user: session!.email });
    return NextResponse.json({ ok: true, count: monitorIds.length, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

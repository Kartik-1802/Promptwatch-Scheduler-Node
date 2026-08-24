import { NextRequest, NextResponse } from "next/server";
import { MUTATE_ROLES, requireRole } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { cleanSchedule, errorResponse, getSession, ValidationError } from "@/lib/http";
import { buildState } from "@/lib/state";
import { tick } from "@/lib/scheduler";
import { log } from "@/lib/store";

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const monitor = await prisma.monitor.findUnique({ where: { id: params.id } });
    if (!monitor) throw new ValidationError("Unknown monitor — run a sync first.");

    const body = await req.json();
    const schedule = cleanSchedule(body);
    await prisma.schedule.upsert({
      where: { monitorId: params.id },
      create: { monitorId: params.id, ...schedule },
      update: schedule,
    });

    const state = schedule.enabled ? "on" : "paused";
    await log(
      "info", "schedule",
      `Schedule ${state} for '${monitor.name}': ${schedule.startTime}–${schedule.endTime} on ${schedule.days.join(",") || "no days"}`,
      { monitorId: params.id, user: session!.email }
    );
    await tick(true, session!.email);
    return NextResponse.json({ ok: true, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const monitor = await prisma.monitor.findUnique({ where: { id: params.id } });
    if (!monitor) throw new ValidationError("Unknown monitor — run a sync first.");

    await prisma.schedule.deleteMany({ where: { monitorId: params.id } });
    await log("info", "schedule", `Schedule removed for '${monitor.name}'`, { monitorId: params.id, user: session!.email });
    await tick(true, session!.email);
    return NextResponse.json({ ok: true, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { MUTATE_ROLES, requireRole } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { cleanBlock, errorResponse, getSession, ValidationError } from "@/lib/http";
import { buildState } from "@/lib/state";
import { blocksOverlap, describeBlock, tick, toBlockLike } from "@/lib/scheduler";
import { log } from "@/lib/store";

/** `id` is a PROJECT id — schedules live on projects, not monitors.
 * Adds a time block to this project's schedule; rejected if it overlaps or
 * touches one the project already has. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const project = await prisma.project.findUnique({
      where: { id: params.id },
      include: { scheduleBlocks: true },
    });
    if (!project) throw new ValidationError("Unknown project — run a sync first.");

    const body = await req.json();
    const block = cleanBlock(body);
    const conflict = project.scheduleBlocks.map(toBlockLike).find((b) => blocksOverlap(b, block));
    if (conflict) {
      throw new ValidationError(`That overlaps an existing block: ${describeBlock(conflict)}. Blocks on the same project can't overlap.`);
    }

    await prisma.scheduleBlock.create({
      data: { projectId: params.id, startDay: block.startDay, startTime: block.startTime, endDay: block.endDay, endTime: block.endTime, trigger: block.trigger },
    });

    await log(
      "info", "schedule.block.added",
      `Added block to '${project.name}': ${describeBlock(block)}`,
      { projectId: params.id, user: session!.email }
    );
    await tick(true, session!.email);
    return NextResponse.json({ ok: true, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Remove every block from this project's schedule (back to manual). */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const project = await prisma.project.findUnique({ where: { id: params.id } });
    if (!project) throw new ValidationError("Unknown project — run a sync first.");

    const { count } = await prisma.scheduleBlock.deleteMany({ where: { projectId: params.id } });
    await log(
      "info", "schedule.block.cleared",
      `Schedule cleared for '${project.name}' — ${count} block(s) removed. Its monitors are now manual.`,
      { projectId: params.id, user: session!.email }
    );
    return NextResponse.json({ ok: true, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

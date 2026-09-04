import { NextRequest, NextResponse } from "next/server";
import { MUTATE_ROLES, requireRole } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { cleanBlock, errorResponse, getSession, ValidationError } from "@/lib/http";
import { buildState } from "@/lib/state";
import { blocksOverlap, describeBlock, tick, toBlockLike } from "@/lib/scheduler";
import { log } from "@/lib/store";

/** Edit one existing block in place. Rejected if the edited range would
 * overlap or touch any of the project's *other* blocks (itself excluded). */
export async function PUT(req: NextRequest, { params }: { params: { id: string; blockId: string } }) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const project = await prisma.project.findUnique({
      where: { id: params.id },
      include: { scheduleBlocks: true },
    });
    if (!project) throw new ValidationError("Unknown project — run a sync first.");
    const existing = project.scheduleBlocks.find((b) => b.id === params.blockId);
    if (!existing) throw new ValidationError("Unknown schedule block.");

    const body = await req.json();
    const block = cleanBlock(body);
    const conflict = project.scheduleBlocks
      .filter((b) => b.id !== params.blockId)
      .map(toBlockLike)
      .find((b) => blocksOverlap(b, block));
    if (conflict) {
      throw new ValidationError(`That overlaps another block on this project: ${describeBlock(conflict)}. Remove or edit that one first.`);
    }

    await prisma.scheduleBlock.update({
      where: { id: params.blockId },
      data: { startDay: block.startDay, startTime: block.startTime, endDay: block.endDay, endTime: block.endTime, trigger: block.trigger },
    });

    await log(
      "info", "schedule.block.edited",
      `Edited a block on '${project.name}': ${describeBlock(toBlockLike(existing))} → ${describeBlock(block)}`,
      { projectId: params.id, user: session!.email }
    );
    await tick(true, session!.email);
    return NextResponse.json({ ok: true, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Remove a single block from a project's schedule, leaving its others alone.
 * `id` is a project id, `blockId` one of its blocks. */
export async function DELETE(req: NextRequest, { params }: { params: { id: string; blockId: string } }) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const project = await prisma.project.findUnique({ where: { id: params.id } });
    if (!project) throw new ValidationError("Unknown project — run a sync first.");

    const existing = await prisma.scheduleBlock.findUnique({ where: { id: params.blockId } });
    if (!existing || existing.projectId !== params.id) throw new ValidationError("Unknown schedule block.");

    await prisma.scheduleBlock.delete({ where: { id: params.blockId } });
    await log(
      "info", "schedule.block.removed",
      `Removed block from '${project.name}': ${describeBlock(toBlockLike(existing))}`,
      { projectId: params.id, user: session!.email }
    );
    await tick(true, session!.email);
    return NextResponse.json({ ok: true, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

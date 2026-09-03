import { NextRequest, NextResponse } from "next/server";
import { MUTATE_ROLES, requireRole } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { cleanBlock, errorResponse, getSession, ValidationError } from "@/lib/http";
import { buildState } from "@/lib/state";
import { blocksOverlap, describeBlock, tick, toBlockLike } from "@/lib/scheduler";
import { log } from "@/lib/store";

/** Edit one existing block. Rejected if it would overlap any of this
 * monitor's other blocks (itself excluded). */
export async function PUT(req: NextRequest, { params }: { params: { id: string; blockId: string } }) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const monitor = await prisma.monitor.findUnique({
      where: { id: params.id },
      include: { scheduleBlocks: true },
    });
    if (!monitor) throw new ValidationError("Unknown monitor — run a sync first.");
    const existing = monitor.scheduleBlocks.find((b) => b.id === params.blockId);
    if (!existing) throw new ValidationError("Unknown schedule block.");

    const body = await req.json();
    const block = cleanBlock(body);
    const conflict = monitor.scheduleBlocks
      .filter((b) => b.id !== params.blockId)
      .map(toBlockLike)
      .find((b) => blocksOverlap(b, block));
    if (conflict) {
      throw new ValidationError(`That overlaps an existing block: ${describeBlock(conflict)}. Blocks on the same monitor can't overlap.`);
    }

    await prisma.scheduleBlock.update({
      where: { id: params.blockId },
      data: { startDay: block.startDay, startTime: block.startTime, endDay: block.endDay, endTime: block.endTime },
    });

    await log(
      "info", "schedule",
      `Edited a block on '${monitor.name}': ${describeBlock(block)}`,
      { monitorId: params.id, user: session!.email }
    );
    await tick(true, session!.email);
    return NextResponse.json({ ok: true, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Remove a single block, leaving the monitor's other blocks untouched. */
export async function DELETE(req: NextRequest, { params }: { params: { id: string; blockId: string } }) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const monitor = await prisma.monitor.findUnique({ where: { id: params.id } });
    if (!monitor) throw new ValidationError("Unknown monitor — run a sync first.");

    const existing = await prisma.scheduleBlock.findUnique({ where: { id: params.blockId } });
    if (!existing || existing.monitorId !== params.id) throw new ValidationError("Unknown schedule block.");

    await prisma.scheduleBlock.delete({ where: { id: params.blockId } });
    await log("info", "schedule", `Removed a block from '${monitor.name}'`, { monitorId: params.id, user: session!.email });
    await tick(true, session!.email);
    return NextResponse.json({ ok: true, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

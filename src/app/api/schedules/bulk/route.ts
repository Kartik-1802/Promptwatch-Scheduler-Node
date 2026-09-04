import { NextRequest, NextResponse } from "next/server";
import { MUTATE_ROLES, requireRole } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { cleanBlock, errorResponse, getSession, ValidationError } from "@/lib/http";
import { buildState } from "@/lib/state";
import { blocksOverlap, describeBlock, tick, toBlockLike } from "@/lib/scheduler";
import { log } from "@/lib/store";

/** Add the same new block to every selected PROJECT. Each project is checked
 * independently — one whose existing blocks would conflict is skipped (not
 * applied to any of them), the rest still get it. */
export async function POST(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const body = await req.json();
    const projectIds: string[] = (body.projectIds || []).map(String);
    if (!projectIds.length) throw new ValidationError("No projects selected.");

    const projects = await prisma.project.findMany({
      where: { id: { in: projectIds } },
      include: { scheduleBlocks: true },
    });
    if (projects.length !== projectIds.length) {
      throw new ValidationError(`${projectIds.length - projects.length} selected project(s) are unknown — run a sync first.`);
    }

    const block = cleanBlock(body);
    const skipped: Array<{ projectId: string; name: string; reason: string }> = [];
    const applied: string[] = [];

    for (const project of projects) {
      const conflict = project.scheduleBlocks.map(toBlockLike).find((b) => blocksOverlap(b, block));
      if (conflict) {
        skipped.push({ projectId: project.id, name: project.name, reason: `overlaps ${describeBlock(conflict)}` });
        continue;
      }
      await prisma.scheduleBlock.create({
        data: { projectId: project.id, startDay: block.startDay, startTime: block.startTime, endDay: block.endDay, endTime: block.endTime, trigger: block.trigger },
      });
      applied.push(project.id);
    }

    if (applied.length) {
      await log(
        "info", "schedule.block.added",
        `Added block to ${applied.length} project(s): ${describeBlock(block)}${skipped.length ? ` (${skipped.length} skipped — overlap)` : ""}`,
        { user: session!.email }
      );
      await tick(true, session!.email);
    }
    return NextResponse.json({ ok: true, applied: applied.length, skipped, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Clear every block from every selected project. */
export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const body = await req.json();
    const projectIds: string[] = (body.projectIds || []).map(String);
    if (!projectIds.length) throw new ValidationError("No projects selected.");

    const { count } = await prisma.scheduleBlock.deleteMany({ where: { projectId: { in: projectIds } } });
    await log("info", "schedule.block.cleared", `Schedule cleared for ${projectIds.length} project(s) — ${count} block(s) removed`, { user: session!.email });
    return NextResponse.json({ ok: true, count: projectIds.length, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

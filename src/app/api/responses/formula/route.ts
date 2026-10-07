import { NextRequest, NextResponse } from 'next/server';
import { requireRole, MUTATE_ROLES } from '@/lib/auth';
import { errorResponse, getSession, ValidationError } from '@/lib/http';
import { prisma } from '@/lib/db';
import { buildState } from '@/lib/state';
import { log } from '@/lib/store';

export async function POST(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const body = await req.json();
    if (typeof body.projectId !== 'string' || !await prisma.project.findUnique({ where: { id: body.projectId } })) throw new ValidationError('Unknown project.');
    if (body.reset === true) {
      await prisma.responseFormula.deleteMany({ where: { projectId: body.projectId } });
    } else {
      const valid = (value: unknown, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
      if ((body.baseResponses !== null && !valid(body.baseResponses, 1_000_000)) || (body.runsPerWeek !== null && !valid(body.runsPerWeek, 100)) || !valid(body.weeksPerMonth, 52) || body.weeksPerMonth < 1) throw new ValidationError('Enter whole numbers: base 0–1,000,000, runs 0–100, weeks 1–52.');
      const data = { baseResponses: body.baseResponses, runsPerWeek: body.runsPerWeek, weeksPerMonth: body.weeksPerMonth };
      await prisma.responseFormula.upsert({ where: { projectId: body.projectId }, create: { projectId: body.projectId, ...data }, update: data });
    }
    await log('info', 'responses.formula', body.reset ? 'Restored automatic response formula' : 'Saved project response formula', { projectId: body.projectId, user: session!.email });
    return NextResponse.json({ state: await buildState() });
  } catch (error) { return errorResponse(error); }
}

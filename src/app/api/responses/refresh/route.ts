import { NextRequest, NextResponse } from 'next/server';
import { requireRole, MUTATE_ROLES } from '@/lib/auth';
import { errorResponse, getSession } from '@/lib/http';
import { refreshResponseUsage } from '@/lib/responses';
import { buildState } from '@/lib/state';
export async function POST(req: NextRequest) {
  try {
    requireRole(await getSession(req), MUTATE_ROLES);
    const result = await refreshResponseUsage();
    return NextResponse.json({ ...result, state: await buildState() });
  } catch (err) { return errorResponse(err); }
}

import { NextRequest, NextResponse } from "next/server";
import { MUTATE_ROLES, requireRole } from "@/lib/auth";
import { errorResponse, getSession, ValidationError } from "@/lib/http";
import { removeMonitors } from "@/lib/monitors";
import { buildState } from "@/lib/state";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const body = await req.json();
    const monitorIds: string[] = body.monitorIds || [];
    if (!monitorIds.length) throw new ValidationError("No monitors selected.");

    const { removed } = await removeMonitors(monitorIds, session!.email);
    return NextResponse.json({ ok: true, removed: removed.length, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

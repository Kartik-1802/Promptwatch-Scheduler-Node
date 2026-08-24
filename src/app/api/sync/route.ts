import { NextRequest, NextResponse } from "next/server";
import { MUTATE_ROLES, requireRole } from "@/lib/auth";
import { errorResponse, getSession, ValidationError } from "@/lib/http";
import { buildState } from "@/lib/state";
import { runSync } from "@/lib/sync";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const { summary, error } = await runSync(session!.email);
    if (error) throw new ValidationError(error);
    return NextResponse.json({ ok: true, summary, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

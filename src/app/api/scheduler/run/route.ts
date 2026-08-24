import { NextRequest, NextResponse } from "next/server";
import { MUTATE_ROLES, requireRole } from "@/lib/auth";
import { errorResponse, getSession } from "@/lib/http";
import { buildState } from "@/lib/state";
import { tick } from "@/lib/scheduler";
import { log } from "@/lib/store";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const changes = await tick(true, session!.email);
    await log("info", "scheduler", `Manual run applied ${changes.length} change(s)`, { user: session!.email });
    return NextResponse.json({ ok: true, changes, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

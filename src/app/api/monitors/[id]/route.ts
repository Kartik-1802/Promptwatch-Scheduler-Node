import { NextRequest, NextResponse } from "next/server";
import { MUTATE_ROLES, requireRole } from "@/lib/auth";
import { errorResponse, getSession } from "@/lib/http";
import { removeMonitors } from "@/lib/monitors";
import { buildState } from "@/lib/state";

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const { removed } = await removeMonitors([params.id], session!.email);
    return NextResponse.json({ ok: true, removed: removed.length, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

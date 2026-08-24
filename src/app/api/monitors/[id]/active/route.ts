import { NextRequest, NextResponse } from "next/server";
import { MUTATE_ROLES, requireRole } from "@/lib/auth";
import { errorResponse, getSession } from "@/lib/http";
import { applyActive } from "@/lib/monitors";
import { buildState } from "@/lib/state";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const body = await req.json();
    await applyActive([params.id], Boolean(body.active), session!.email);
    return NextResponse.json({ ok: true, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { inviteUser, listUsers, requireRole, SUPERADMIN_ROLES } from "@/lib/auth";
import { errorResponse, getSession } from "@/lib/http";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, SUPERADMIN_ROLES);
    return NextResponse.json({ users: await listUsers() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, SUPERADMIN_ROLES);
    const body = await req.json();
    const user = await inviteUser(session!.email, body.email, body.role, body.password);
    return NextResponse.json({ ok: true, user, users: await listUsers() });
  } catch (err) {
    return errorResponse(err);
  }
}

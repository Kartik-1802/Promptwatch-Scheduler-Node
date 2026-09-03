import { NextRequest, NextResponse } from "next/server";
import { deleteUser, listUsers, requireRole, TEAM_ROLES, updateUser } from "@/lib/auth";
import { errorResponse, getSession } from "@/lib/http";

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession(req);
    requireRole(session, TEAM_ROLES);
    const body = await req.json();
    const user = await updateUser(session!.email, session!.role, params.id, {
      role: body.role,
      password: body.password,
      active: body.active,
    });
    return NextResponse.json({ ok: true, user, users: await listUsers() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getSession(req);
    requireRole(session, TEAM_ROLES);
    await deleteUser(session!.email, params.id);
    return NextResponse.json({ ok: true, users: await listUsers() });
  } catch (err) {
    return errorResponse(err);
  }
}

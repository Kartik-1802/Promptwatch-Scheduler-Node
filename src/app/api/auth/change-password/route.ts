import { NextRequest, NextResponse } from "next/server";
import { changePassword, requireRole, VIEW_ROLES } from "@/lib/auth";
import { errorResponse, getSession } from "@/lib/http";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, VIEW_ROLES);
    const body = await req.json();
    await changePassword(session!.userId, body.currentPassword || "", body.newPassword || "");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireRole, VIEW_ROLES } from "@/lib/auth";
import { errorResponse, getSession } from "@/lib/http";
import { buildState } from "@/lib/state";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, VIEW_ROLES);
    return NextResponse.json(await buildState());
  } catch (err) {
    return errorResponse(err);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireRole, VIEW_ROLES } from "@/lib/auth";
import { errorResponse, getSession } from "@/lib/http";
import { availableTimezones } from "@/lib/tz";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, VIEW_ROLES);
    return NextResponse.json({ timezones: availableTimezones().sort() });
  } catch (err) {
    return errorResponse(err);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireRole, VIEW_ROLES } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorResponse, getSession } from "@/lib/http";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, VIEW_ROLES);
    const rows = await prisma.logEntry.findMany({ orderBy: { ts: "desc" }, take: 300 });
    const logs = rows.map((l) => ({
      ts: l.ts.getTime() / 1000,
      level: l.level,
      event: l.event,
      message: l.message,
      user: l.user,
      kind: l.kind,
      monitorId: l.monitorId,
      projectId: l.projectId,
      code: l.code,
    }));
    return NextResponse.json({ logs });
  } catch (err) {
    return errorResponse(err);
  }
}

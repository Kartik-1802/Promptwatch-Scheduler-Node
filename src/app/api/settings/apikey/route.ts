import { NextRequest, NextResponse } from "next/server";
import { requireRole, SETTINGS_ROLES } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorResponse, getSession } from "@/lib/http";
import { log } from "@/lib/store";
import { buildState } from "@/lib/state";

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, SETTINGS_ROLES);

    await prisma.settings.update({ where: { id: 1 }, data: { apiKey: null } });
    await prisma.monitor.deleteMany({});
    await prisma.project.deleteMany({});
    await log("warn", "settings", "API key removed; cached projects and monitors cleared", { user: session!.email });

    return NextResponse.json({ ok: true, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireRole, SETTINGS_ROLES } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorResponse, getSession, ValidationError } from "@/lib/http";
import { log, publicSettings } from "@/lib/store";
import { isValidTimezone } from "@/lib/tz";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, SETTINGS_ROLES);
    const body = await req.json();

    const data: Record<string, unknown> = {};
    if ("apiKey" in body) {
      const key = (body.apiKey || "").trim();
      if (key) data.apiKey = key;
    }
    if ("timezone" in body) {
      if (!isValidTimezone(body.timezone)) throw new ValidationError(`Unknown timezone: ${body.timezone}`);
      data.timezone = body.timezone;
    }
    if ("tickSeconds" in body) {
      data.tickSeconds = Math.max(10, parseInt(body.tickSeconds, 10) || 60);
    }
    if ("schedulerEnabled" in body) {
      data.schedulerEnabled = Boolean(body.schedulerEnabled);
    }

    await prisma.settings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    await log("info", "settings", "Settings updated", { user: session!.email });

    const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
    return NextResponse.json({ ok: true, settings: publicSettings(settings) });
  } catch (err) {
    return errorResponse(err);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireRole, SETTINGS_ROLES } from "@/lib/auth";
import { getSettings } from "@/lib/store";
import { errorResponse, getSession, ValidationError } from "@/lib/http";
import { PromptwatchClient } from "@/lib/promptwatch";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, SETTINGS_ROLES);
    const body = await req.json().catch(() => ({}));
    const settings = await getSettings();
    const key = body.apiKey || settings.apiKey;
    if (!key) throw new ValidationError("No API key to test.");
    const projects = await new PromptwatchClient(key).listProjects();
    return NextResponse.json({ ok: true, projects: projects.length });
  } catch (err) {
    return errorResponse(err);
  }
}

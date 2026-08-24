import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { MUTATE_ROLES, requireRole } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorResponse, getSession, ValidationError } from "@/lib/http";
import { ApiError, PromptwatchClient } from "@/lib/promptwatch";
import { buildState } from "@/lib/state";
import { log } from "@/lib/store";

const KEPT_FIELDS = [
  "name", "description", "active", "models", "languageCode", "countryCode",
  "promptFrequency", "promptCount", "responseCount", "averageVisibility",
] as const;

export async function POST(req: NextRequest) {
  try {
    const session = await getSession(req);
    requireRole(session, MUTATE_ROLES);
    const body = await req.json();

    const projectId = (body.projectId || "").trim();
    const rawIds: (string | undefined)[] = body.monitorIds ?? [body.monitorId];
    const monitorIds = [...new Set(rawIds.map((x) => (x || "").trim()).filter(Boolean))];
    if (!projectId || !monitorIds.length) {
      throw new ValidationError("A project and at least one monitor ID are required.");
    }

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings?.apiKey) throw new ValidationError("No API key configured.");
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new ValidationError("Unknown project — run a sync first.");

    const client = new PromptwatchClient(settings.apiKey);
    const added: string[] = [];
    const failed: Array<{ id: string; message: string }> = [];

    for (const monitorId of monitorIds) {
      try {
        const item = await client.getMonitor(projectId, monitorId);
        const data: Record<string, unknown> = { projectId, projectName: project.name, seenAt: new Date(), nextRetryAt: null };
        for (const key of KEPT_FIELDS) if (item[key] !== undefined) data[key] = item[key];
        // SQLite has no array column type — models is stored as a JSON string.
        data.models = JSON.stringify(Array.isArray(data.models) ? data.models : []);

        await prisma.monitor.upsert({
          where: { id: monitorId },
          create: { id: monitorId, ...data } as Prisma.MonitorUncheckedCreateInput,
          update: data,
        });
        added.push(item.name as string);
      } catch (err) {
        const apiErr = err as ApiError;
        failed.push({ id: monitorId, message: apiErr.message });
      }
    }

    if (added.length) await log("info", "sync", `Added ${added.length} monitor(s) by ID: ${added.join(", ")}`, { user: session!.email });
    for (const item of failed) await log("warn", "sync", `Could not add monitor ${item.id}: ${item.message}`, { user: session!.email });

    return NextResponse.json({ ok: true, added: added.length, failed, state: await buildState() });
  } catch (err) {
    return errorResponse(err);
  }
}

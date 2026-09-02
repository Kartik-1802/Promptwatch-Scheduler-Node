/** Pull projects + monitors from Promptwatch into the local database. Mirrors sync.py. */
import { prisma } from "./db";
import { Prisma } from "@prisma/client";
import { ApiError, PromptwatchClient, PromptwatchMonitor } from "./promptwatch";
import { log } from "./store";

const KEPT_MONITOR_FIELDS = [
  "name", "description", "active", "models", "languageCode", "countryCode",
  "promptFrequency", "promptCount", "responseCount", "averageVisibility",
] as const;

function monitorData(item: PromptwatchMonitor) {
  const data: Record<string, unknown> = {};
  for (const key of KEPT_MONITOR_FIELDS) {
    if (item[key] !== undefined) data[key] = item[key];
  }
  // models is stored as a JSON-encoded string — see src/lib/json.ts.
  data.models = JSON.stringify(Array.isArray(data.models) ? data.models : []);
  if (item.updatedAt) data.updatedAt = new Date(item.updatedAt as string);
  return data;
}

export async function runSync(actor = "System") {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.apiKey) return { summary: null, error: "No API key configured." };

  const client = new PromptwatchClient(settings.apiKey);
  let projects;
  try {
    projects = await client.listProjects();
  } catch (err) {
    const apiErr = err as ApiError;
    await log("error", "sync", `Project sync failed: ${apiErr.message}`, { code: apiErr.code, user: actor });
    return { summary: null, error: apiErr.message };
  }

  const seenIds = new Set<string>();
  const errors: string[] = [];
  let monitorCount = 0;

  await prisma.project.deleteMany({});
  await prisma.project.createMany({
    data: projects.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug ?? null,
      website: p.website ?? null,
      createdAt: p.createdAt ? new Date(p.createdAt) : null,
    })),
  });

  for (const project of projects) {
    let remote: PromptwatchMonitor[] = [];
    try {
      remote = await client.listMonitors(project.id);
    } catch (err) {
      const apiErr = err as ApiError;
      errors.push(`${project.name}: ${apiErr.message}`);
    }

    for (const item of remote) {
      seenIds.add(item.id);
      await prisma.monitor.upsert({
        where: { id: item.id },
        create: { id: item.id, projectId: project.id, projectName: project.name, seenAt: new Date(), ...monitorData(item) } as Prisma.MonitorUncheckedCreateInput,
        update: { projectId: project.id, projectName: project.name, seenAt: new Date(), nextRetryAt: null, ...monitorData(item) },
      });
      monitorCount++;
    }

    // /monitors only returns active monitors. /prompts isn't filtered by monitor
    // status, so every prompt's owning monitor reveals an inactive one too.
    let discovered = new Map<string, string | undefined>();
    try {
      discovered = await client.iterProjectMonitorIds(project.id);
    } catch (err) {
      const apiErr = err as ApiError;
      errors.push(`${project.name} (inactive monitor discovery): ${apiErr.message}`);
    }

    for (const monitorId of discovered.keys()) {
      if (seenIds.has(monitorId)) continue;
      let item: PromptwatchMonitor;
      try {
        item = await client.getMonitor(project.id, monitorId);
      } catch (err) {
        const apiErr = err as ApiError;
        if (apiErr.status === 404 || apiErr.code === "MONITOR_NOT_FOUND") continue;
        errors.push(`${project.name} (monitor ${monitorId}): ${apiErr.message}`);
        continue;
      }
      seenIds.add(monitorId);
      await prisma.monitor.upsert({
        where: { id: monitorId },
        create: { id: monitorId, projectId: project.id, projectName: project.name, seenAt: new Date(), ...monitorData(item) } as Prisma.MonitorUncheckedCreateInput,
        update: { projectId: project.id, projectName: project.name, seenAt: new Date(), nextRetryAt: null, ...monitorData(item) },
      });
      monitorCount++;
    }
  }

  // A monitor can fall out of both /monitors and /prompts (e.g. zero prompts left).
  // Re-read anything we already knew about but didn't see this pass, rather than
  // silently dropping it from the dashboard.
  const known = await prisma.monitor.findMany({ where: { id: { notIn: [...seenIds] } } });
  for (const monitor of known) {
    try {
      const item = await client.getMonitor(monitor.projectId, monitor.id);
      await prisma.monitor.update({
        where: { id: monitor.id },
        data: { seenAt: new Date(), ...monitorData(item) },
      });
      monitorCount++;
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 404 || apiErr.code === "MONITOR_NOT_FOUND") {
        await prisma.monitor.delete({ where: { id: monitor.id } }).catch(() => {});
        await log("warn", "sync", `Monitor '${monitor.name}' no longer exists — removed`);
        continue;
      }
      await prisma.monitor.update({
        where: { id: monitor.id },
        data: { seenAt: new Date(), staleSince: monitor.staleSince ?? new Date() },
      });
      monitorCount++;
    }
  }

  // Drop schedules whose monitor is gone.
  const liveIds = await prisma.monitor.findMany({ select: { id: true } });
  const liveIdSet = new Set(liveIds.map((m) => m.id));
  const orphanedSchedules = await prisma.schedule.findMany({ select: { monitorId: true } });
  const toDelete = orphanedSchedules.filter((s) => !liveIdSet.has(s.monitorId)).map((s) => s.monitorId);
  if (toDelete.length) {
    await prisma.schedule.deleteMany({ where: { monitorId: { in: toDelete } } });
  }

  await prisma.settings.update({ where: { id: 1 }, data: { lastSyncAt: new Date() } });

  const summary = { projects: projects.length, monitors: monitorCount, errors };
  const level = errors.length ? "warn" : "success";
  await log(
    level,
    "sync",
    `Synced ${projects.length} project(s), ${monitorCount} monitor(s)` +
      (errors.length ? ` — ${errors.length} project error(s)` : ""),
    { user: actor }
  );
  return { summary, error: null };
}

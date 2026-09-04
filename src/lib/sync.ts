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

  // Upsert rather than wipe-and-recreate: schedule blocks hang off Project
  // with onDelete: Cascade, so deleting projects here would silently destroy
  // every schedule on every sync.
  for (const p of projects) {
    const data = {
      name: p.name,
      slug: p.slug ?? null,
      website: p.website ?? null,
      createdAt: p.createdAt ? new Date(p.createdAt) : null,
    };
    await prisma.project.upsert({
      where: { id: p.id },
      create: { id: p.id, ...data },
      update: data,
    });
  }

  // Projects that no longer exist upstream do get removed (and their blocks
  // with them) — but only those, not the whole table.
  const liveProjectIds = new Set(projects.map((p) => p.id));
  const staleProjects = await prisma.project.findMany({ select: { id: true } });
  const goneIds = staleProjects.filter((p) => !liveProjectIds.has(p.id)).map((p) => p.id);
  if (goneIds.length) {
    await prisma.project.deleteMany({ where: { id: { in: goneIds } } });
    await log("warn", "sync", `${goneIds.length} project(s) no longer exist upstream — removed with their schedules`, { user: actor });
  }

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
      // The list endpoint above (GET /monitors) can return an abbreviated
      // "name" for a monitor compared to its own single-record endpoint —
      // e.g. two Promptwatch monitors that look identically named here even
      // though one is really "X" and the other "X - 0 monitor". Re-fetch the
      // full record so the name (and every other field) always comes from
      // the authoritative source, the same way discovered monitors already
      // do a few lines below. Falls back to the list item if that fails, so
      // a single bad monitor can't stall the whole sync.
      let full = item;
      try {
        full = await client.getMonitor(project.id, item.id);
      } catch (err) {
        const apiErr = err as ApiError;
        errors.push(`${project.name} (monitor ${item.id} detail fetch): ${apiErr.message}`);
      }
      await prisma.monitor.upsert({
        where: { id: item.id },
        create: { id: item.id, projectId: project.id, projectName: project.name, seenAt: new Date(), ...monitorData(full) } as Prisma.MonitorUncheckedCreateInput,
        update: { projectId: project.id, projectName: project.name, seenAt: new Date(), nextRetryAt: null, ...monitorData(full) },
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

  // Schedule blocks are cascade-deleted with their project above, so there's
  // nothing to prune here any more.
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

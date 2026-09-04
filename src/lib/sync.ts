/** Pull projects + monitors from Promptwatch into the local database. Mirrors sync.py.
 *
 * Our own DB is the persisted inventory of managed monitors, not Promptwatch's
 * `/monitors` list — that endpoint only ever returns active monitors, so
 * treating it as the inventory would mean a monitor silently drops out of
 * scheduling/management the moment it's turned off. Instead this runs in two
 * separate passes:
 *   1. Discovery — find monitor IDs we don't have a row for yet (via the
 *      active list and via /prompts, which isn't filtered by active status)
 *      and add them.
 *   2. Refresh — for every monitor already in our DB, regardless of how it
 *      was discovered or its current active status, fetch its current record
 *      directly by ID and update it. This is sync's main job on every run
 *      after the first: keep each persisted monitor's active/tick state
 *      current, not rediscover which monitors exist.
 * A monitor's row is never deleted here, even on a 404 from Promptwatch —
 * it's marked stale instead, so a transient lookup failure (or an actual
 * upstream deletion) never silently destroys its local history or schedule
 * eligibility. */
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

  const errors: string[] = [];
  let discoveredCount = 0;

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

  // --- Pass 1: discovery — add monitor IDs we've never seen before. ---
  const existingIds = new Set((await prisma.monitor.findMany({ select: { id: true } })).map((m) => m.id));

  for (const project of projects) {
    let active: PromptwatchMonitor[] = [];
    try {
      active = await client.listMonitors(project.id);
    } catch (err) {
      const apiErr = err as ApiError;
      errors.push(`${project.name}: ${apiErr.message}`);
    }
    for (const item of active) {
      if (existingIds.has(item.id)) continue;
      await createMonitor(client, project.id, project.name, item.id, item, errors);
      existingIds.add(item.id);
      discoveredCount++;
    }

    // /monitors only returns active monitors. /prompts isn't filtered by
    // monitor status, so every prompt's owning monitor reveals an inactive
    // one too — this is what lets a never-before-seen inactive monitor get
    // discovered at all.
    let seenInPrompts = new Map<string, string | undefined>();
    try {
      seenInPrompts = await client.iterProjectMonitorIds(project.id);
    } catch (err) {
      const apiErr = err as ApiError;
      errors.push(`${project.name} (inactive monitor discovery): ${apiErr.message}`);
    }
    for (const monitorId of seenInPrompts.keys()) {
      if (existingIds.has(monitorId)) continue;
      const ok = await createMonitor(client, project.id, project.name, monitorId, null, errors);
      if (ok) {
        existingIds.add(monitorId);
        discoveredCount++;
      }
    }
  }

  // --- Pass 2: refresh — every already-persisted monitor, by ID, regardless
  // of discovery source or current active status. This is what keeps a
  // monitor's active/tick state current after it's been turned off, instead
  // of it falling out of sync the moment it stops appearing in the active
  // list. Never deletes a row — a 404 just marks it stale. ---
  const known = await prisma.monitor.findMany();
  let refreshedCount = 0;

  for (const monitor of known) {
    try {
      const item = await client.getMonitor(monitor.projectId, monitor.id);
      await prisma.monitor.update({
        where: { id: monitor.id },
        data: { seenAt: new Date(), staleSince: null, ...monitorData(item) },
      });
      refreshedCount++;
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 404 || apiErr.code === "MONITOR_NOT_FOUND") {
        if (!monitor.staleSince) {
          await log(
            "warn", "sync",
            `Monitor '${monitor.name}' not found on Promptwatch (may have been deleted there) — kept locally, marked stale`,
            { monitorId: monitor.id, projectId: monitor.projectId, user: actor }
          );
        }
        await prisma.monitor.update({ where: { id: monitor.id }, data: { staleSince: monitor.staleSince ?? new Date() } });
        continue;
      }
      errors.push(`${monitor.projectName} (monitor ${monitor.name} refresh): ${apiErr.message}`);
      await prisma.monitor.update({
        where: { id: monitor.id },
        data: { staleSince: monitor.staleSince ?? new Date() },
      });
    }
  }

  await prisma.settings.update({ where: { id: 1 }, data: { lastSyncAt: new Date() } });

  const monitorCount = discoveredCount + refreshedCount;
  const summary = { projects: projects.length, monitors: monitorCount, errors };
  const level = errors.length ? "warn" : "success";
  await log(
    level,
    "sync",
    `Synced ${projects.length} project(s) — ${discoveredCount} new monitor(s) discovered, ${refreshedCount} refreshed` +
      (errors.length ? ` — ${errors.length} error(s)` : ""),
    { user: actor }
  );
  return { summary, error: null };
}

/** Fetches the full record for a newly-discovered monitor (the list/prompts
 * endpoints can carry an abbreviated record) and creates its row. Returns
 * whether it succeeded, so discovery can skip counting/marking it on failure. */
async function createMonitor(
  client: PromptwatchClient,
  projectId: string,
  projectName: string,
  monitorId: string,
  fallback: PromptwatchMonitor | null,
  errors: string[]
): Promise<boolean> {
  let item = fallback;
  try {
    item = await client.getMonitor(projectId, monitorId);
  } catch (err) {
    const apiErr = err as ApiError;
    if (!item) {
      if (apiErr.status === 404 || apiErr.code === "MONITOR_NOT_FOUND") return false; // never existed long enough to fetch
      errors.push(`${projectName} (monitor ${monitorId}): ${apiErr.message}`);
      return false;
    }
    errors.push(`${projectName} (monitor ${monitorId} detail fetch): ${apiErr.message}`);
  }
  await prisma.monitor.create({
    data: { id: monitorId, projectId, projectName, seenAt: new Date(), ...monitorData(item!) } as Prisma.MonitorUncheckedCreateInput,
  });
  return true;
}

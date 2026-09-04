import { prisma } from "./db";
import { parseStringArray } from "./json";
import { evaluate, getLastTickAt, nextTransition, toBlockLike } from "./scheduler";
import { getSettings, publicSettings } from "./store";
import { partsAt } from "./tz";

export async function buildState() {
  const settings = await getSettings();
  const parts = partsAt(new Date(), settings.timezone);
  const minutes = parts.hour * 60 + parts.minute;

  const [projectsRaw, monitorsRaw] = await Promise.all([
    prisma.project.findMany({
      include: { scheduleBlocks: { orderBy: [{ startDay: "asc" }, { startTime: "asc" }] } },
      orderBy: { name: "asc" },
    }),
    prisma.monitor.findMany({ orderBy: [{ projectName: "asc" }, { name: "asc" }] }),
  ]);

  const monitors = monitorsRaw.map((m) => ({
    id: m.id,
    projectId: m.projectId,
    projectName: m.projectName,
    name: m.name,
    description: m.description,
    active: m.active,
    models: parseStringArray(m.models),
    languageCode: m.languageCode,
    countryCode: m.countryCode,
    promptFrequency: m.promptFrequency,
    promptCount: m.promptCount,
    responseCount: m.responseCount,
    averageVisibility: m.averageVisibility,
    staleSince: m.staleSince ? m.staleSince.toISOString() : null,
  }));

  // Each project carries its own schedule plus the live counts the homepage
  // needs, so every project's state is visible without opening it.
  const projects = projectsRaw.map((p) => {
    const blocks = p.scheduleBlocks.map(toBlockLike);
    const desired = evaluate(blocks, parts.weekday, minutes);
    const own = monitors.filter((m) => m.projectId === p.id);
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      website: p.website,
      createdAt: p.createdAt ? p.createdAt.toISOString() : null,
      blocks: p.scheduleBlocks.map((b) => ({
        id: b.id,
        startDay: b.startDay,
        startTime: b.startTime,
        endDay: b.endDay,
        endTime: b.endTime,
        trigger: b.trigger,
      })),
      desiredActive: desired,
      inWindow: desired,
      nextTransition: nextTransition(blocks, settings.timezone),
      monitorCount: own.length,
      activeCount: own.filter((m) => m.active).length,
    };
  });

  return {
    settings: publicSettings(settings),
    projects,
    monitors,
    lastSyncAt: settings.lastSyncAt ? settings.lastSyncAt.getTime() / 1000 : null,
    lastTickAt: getLastTickAt() ? getLastTickAt()! / 1000 : null,
    serverNow: new Date().toISOString(),
  };
}

export async function usageStats(hours = 24) {
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const calls = await prisma.apiCallLog.findMany({ where: { ts: { gte: since } } });
  const now = Date.now();

  const buckets = new Map<number, { hour: number; total: number; errors: number; ms: number }>();
  for (let offset = 0; offset < hours; offset++) {
    const stamp = Math.floor((since.getTime() + offset * 3600 * 1000) / 3600000) * 3600;
    buckets.set(stamp, { hour: stamp, total: 0, errors: 0, ms: 0 });
  }

  for (const call of calls) {
    const stamp = Math.floor(call.ts.getTime() / 3600000) * 3600;
    const bucket = buckets.get(stamp);
    if (!bucket) continue;
    bucket.total += 1;
    bucket.ms += call.ms ?? 0;
    if (call.status < 200 || call.status >= 300) bucket.errors += 1;
  }

  const series = [...buckets.values()]
    .sort((a, b) => a.hour - b.hour)
    .map((b) => ({ ...b, avgMs: b.total ? Math.round(b.ms / b.total) : 0 }));

  const lastHourCount = calls.filter((c) => c.ts.getTime() >= now - 3600 * 1000).length;

  const byEndpoint = new Map<string, number>();
  for (const call of calls) {
    const key = `${call.method} ${call.path.replace(/\/[0-9a-fA-F-]{16,}/g, "/{id}")}`;
    byEndpoint.set(key, (byEndpoint.get(key) ?? 0) + 1);
  }

  return {
    series,
    lastHour: lastHourCount,
    last24h: calls.length,
    errors24h: series.reduce((sum, b) => sum + b.errors, 0),
    byEndpoint: [...byEndpoint.entries()]
      .map(([endpoint, count]) => ({ endpoint, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
  };
}

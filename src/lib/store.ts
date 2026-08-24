import { prisma } from "./db";

const API_CALL_RETENTION_HOURS = 48;
const MAX_LOGS = 2000;

export async function log(
  level: "success" | "info" | "warn" | "error",
  event: string,
  message: string,
  extra: { user?: string; kind?: string; monitorId?: string; projectId?: string; code?: string } = {}
) {
  await prisma.logEntry.create({ data: { level, event, message, ...extra } });

  const count = await prisma.logEntry.count();
  if (count > MAX_LOGS) {
    const overflow = await prisma.logEntry.findMany({
      orderBy: { ts: "asc" },
      take: count - MAX_LOGS,
      select: { id: true },
    });
    await prisma.logEntry.deleteMany({ where: { id: { in: overflow.map((o) => o.id) } } });
  }
}

export async function recordApiCall(method: string, path: string, status: number, ms: number, error?: string) {
  await prisma.apiCallLog.create({ data: { method, path, status, ms, error: error ?? null } });
  const cutoff = new Date(Date.now() - API_CALL_RETENTION_HOURS * 3600 * 1000);
  await prisma.apiCallLog.deleteMany({ where: { ts: { lt: cutoff } } });
}

export async function getSettings() {
  let settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) {
    settings = await prisma.settings.create({ data: { id: 1 } });
  }
  return settings;
}

function maskKey(key: string | null) {
  if (!key) return null;
  return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : "•".repeat(key.length);
}

export function publicSettings(settings: Awaited<ReturnType<typeof getSettings>>) {
  return {
    hasApiKey: Boolean(settings.apiKey),
    apiKeyMask: maskKey(settings.apiKey),
    timezone: settings.timezone,
    tickSeconds: settings.tickSeconds,
    schedulerEnabled: settings.schedulerEnabled,
  };
}

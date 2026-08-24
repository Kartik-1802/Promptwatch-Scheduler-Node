import { prisma } from "./db";
import { ApiError, PromptwatchClient } from "./promptwatch";
import { log } from "./store";
import { ValidationError } from "./http";

export async function applyActive(
  monitorIds: string[],
  active: boolean,
  actor: string,
  tolerateErrors = false
): Promise<{ changed: string[]; failed: Array<{ id: string; message: string }> }> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.apiKey) throw new ValidationError("No API key configured.");

  const monitors = await prisma.monitor.findMany({ where: { id: { in: monitorIds } } });
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const client = new PromptwatchClient(settings.apiKey);

  const changed: string[] = [];
  const failed: Array<{ id: string; message: string }> = [];

  for (const monitorId of monitorIds) {
    const monitor = byId.get(monitorId);
    if (!monitor) {
      if (!tolerateErrors) throw new ValidationError("Unknown monitor.");
      failed.push({ id: monitorId, message: "Unknown monitor." });
      continue;
    }
    try {
      await client.setMonitorActive(monitor.projectId, monitorId, active);
    } catch (err) {
      const apiErr = err as ApiError;
      if (!tolerateErrors) throw apiErr;
      failed.push({ id: monitorId, message: apiErr.message });
      await log(
        "error", "manual",
        `Failed to ${active ? "activate" : "deactivate"} '${monitor.name}': ${apiErr.message}`,
        { monitorId, user: actor }
      );
      continue;
    }
    changed.push(monitorId);
    await log(
      "info", "manual",
      `Manually ${active ? "activated" : "deactivated"} '${monitor.name}'`,
      { monitorId, projectId: monitor.projectId, user: actor, kind: active ? "activate" : "deactivate" }
    );
  }

  if (changed.length) {
    await prisma.monitor.updateMany({ where: { id: { in: changed } }, data: { active, nextRetryAt: null } });
  }
  return { changed, failed };
}

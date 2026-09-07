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

/** Stops tracking the given monitors locally — deletes their rows from our
 * inventory. This never touches Promptwatch itself (there's no delete-monitor
 * call to the API here); it only removes the local row that drives this
 * app's dashboard, scheduling eligibility and active-count. A monitor that's
 * still active or still has prompts upstream will be rediscovered by the
 * next sync, exactly like it was the first time — removal here is "stop
 * tracking for now", not "block forever". */
export async function removeMonitors(monitorIds: string[], actor: string): Promise<{ removed: string[] }> {
  const monitors = await prisma.monitor.findMany({ where: { id: { in: monitorIds } } });
  if (!monitors.length) return { removed: [] };

  await prisma.monitor.deleteMany({ where: { id: { in: monitors.map((m) => m.id) } } });

  const byProject = new Map<string, string[]>();
  for (const m of monitors) byProject.set(m.projectName, [...(byProject.get(m.projectName) ?? []), m.name]);
  for (const [projectName, names] of byProject) {
    await log("info", "manual", `Removed ${names.length} monitor(s) from '${projectName}': ${names.join(", ")}`, { user: actor });
  }
  return { removed: monitors.map((m) => m.id) };
}

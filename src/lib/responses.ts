import type { ResponseUsage, ResponseUsageReport } from '@prisma/client';
import { prisma } from './db';
import { OrganizationUsage, PromptwatchClient } from './promptwatch';
import { addDays, midnight, planResponses, predictionAlert, RESPONSE_LIMIT, responsePeriods, remainingPlan, weekday, PlanBlock, PlanMonitor } from './response-plan';

const REFRESH_MS = 60 * 60_000;
export type ProjectConsumption = { id: string; name: string; responses: number; cap: number | null };
export function normalizeUsage(data: OrganizationUsage, now: Date) {
  const counter = data.organization?.promptResponses;
  const periodFrom = new Date(data.period?.from ?? '');
  const periodTo = new Date(counter?.resetsAt ?? (data.period?.to ? new Date(new Date(data.period.to).getTime() + 1).toISOString() : ''));
  const validCount = (value: number) => Number.isSafeInteger(value) && value >= 0;
  if (!counter || !validCount(counter.current) || !validCount(counter.limit) || !Number.isFinite(periodFrom.getTime()) || !Number.isFinite(periodTo.getTime()) || periodFrom > now || periodTo <= now || !Array.isArray(data.projects)) throw new Error('Promptwatch did not return a valid current usage period.');
  const projects = data.projects.map(p => {
    if (typeof p.id !== 'string' || !validCount(p.usage?.promptResponses?.current)) throw new Error('Promptwatch returned an invalid project usage count.');
    return { id: p.id, name: p.name, responses: p.usage.promptResponses.current, cap: p.usage.promptResponses.cap };
  });
  if (new Set(projects.map(p => p.id)).size !== projects.length) throw new Error('Promptwatch returned duplicate project usage rows.');
  return { periodFrom, periodTo, responses: counter.current, providerLimit: counter.limit, projects, observedAt: now };
}
let refreshing: Promise<{ errors: string[] }> | null = null;
export async function refreshResponseUsage() {
  if (refreshing) return refreshing;
  refreshing = refresh().finally(() => { refreshing = null; });
  return refreshing;
}
async function refresh() {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
  if (!settings.apiKey) return { errors: ['Add an organization-level API key to load actual response consumption.'] };
  const now = new Date();
  const client = new PromptwatchClient(settings.apiKey);
  let report = await prisma.responseUsageReport.findFirst({ orderBy: { periodFrom: 'desc' } });
  const errors: string[] = [];
  if (!report || report.periodTo <= now || now.getTime() - report.observedAt.getTime() >= REFRESH_MS) {
    try {
      const data = normalizeUsage(await client.getOrganizationUsage(), now);
      report = await prisma.responseUsageReport.upsert({ where: { periodFrom: data.periodFrom }, create: data, update: data });
    } catch (error) {
      return { errors: [`Official usage: ${(error as Error).message}. Monthly consumption needs an organization-level API key.`] };
    }
  }
  const p = responsePeriods(now, settings.timezone, report);
  const projects = await prisma.project.findMany();
  const ranges = [...new Map([[p.weekStart, p.weekEnd], [p.today, addDays(p.today, 1)]].map(([start, end]) => [start + end, { start, end }])).values()];
  // /usage has monthly counters only. Dated records support the weekly comparison
  // and estimating today's remaining run; they never replace official consumption.
  for (const project of projects) {
    for (const range of ranges) {
      const key = { projectId: project.id, ...range, timezone: settings.timezone };
      const old = await prisma.responseUsage.findUnique({ where: { projectId_start_end_timezone: key } });
      if (old && now.getTime() - old.observedAt.getTime() < REFRESH_MS) continue;
      try {
        const from = new Date(Math.max(midnight(range.start, settings.timezone).getTime(), report.periodFrom.getTime()));
        const until = new Date(Math.min(midnight(range.end, settings.timezone).getTime() - 1, report.periodTo.getTime() - 1, now.getTime()));
        if (from > until) continue;
        const responses = await client.countResponses(project.id, from.toISOString(), until.toISOString());
        await prisma.responseUsage.upsert({ where: { projectId_start_end_timezone: key }, create: { ...key, responses, observedAt: now }, update: { responses, observedAt: now } });
      } catch (error) {
        errors.push(`${project.name}: ${(error as Error).message}`);
        break; // Retain last successful observations; failure never means zero.
      }
    }
  }
  return { errors };
}

type ProjectPlan = { id: string; blocks: PlanBlock[] };
type MonitorPlan = PlanMonitor & { id?: string; projectId: string };
export async function responseState(projects: ProjectPlan[], monitors: MonitorPlan[], timezone: string, automated: boolean, now = new Date()) {
  const report = await prisma.responseUsageReport.findFirst({ orderBy: { periodFrom: 'desc' } });
  const period = responsePeriods(now, timezone, report);
  const usage = await prisma.responseUsage.findMany({ where: { timezone, start: { gte: period.start, lte: period.today } } });
  return summarizeResponses(projects, monitors, timezone, automated, now, usage, report);
}
export function summarizeResponses(projects: ProjectPlan[], monitors: MonitorPlan[], timezone: string, automated: boolean, now: Date, usage: ResponseUsage[], report: ResponseUsageReport | null = null) {
  const period = responsePeriods(now, timezone, report);
  const currentReport = report && report.periodFrom <= now && report.periodTo > now ? report : null;
  const consumption = (currentReport?.projects ?? []) as ProjectConsumption[];
  const find = (id: string, start: string, end: string) => usage.find(u => u.projectId === id && u.start === start && u.end === end);
  const estimateWeekStart = addDays(period.today, -weekday(period.today));
  const estimateWeekEnd = addDays(estimateWeekStart, 7);
  const byMonitor = Object.fromEntries(monitors.filter(m => m.id).map(m => {
    const blocks = projects.find(p => p.id === m.projectId)?.blocks ?? [];
    const weekly = planResponses([m], blocks, estimateWeekStart, estimateWeekEnd, timezone, automated);
    return [m.id!, {
      daily: m.active ? Math.max(0, m.promptCount ?? 0) * m.models.length : 0,
      weekly,
      monthly: weekly * 4,
    }];
  }));
  const byProject = Object.fromEntries(projects.map(project => {
    const own = monitors.filter(m => m.projectId === project.id);
    const plan = (start: string, end: string, holds = false) => planResponses(own, project.blocks, start, end, timezone, automated, holds);
    const month = consumption.find(p => p.id === project.id);
    const week = find(project.id, period.weekStart, period.weekEnd);
    const weekly = plan(estimateWeekStart, estimateWeekEnd);
    const predicted = weekly * 4;
    const remaining = remainingPlan(weekly, now, period.resetAt).responses;
    const used = month?.responses ?? null;
    // In the first week both periods start together: use the official count.
    const weeklyOfficial = period.weekStart === period.start;
    return [project.id, {
      used, providerCap: month?.cap ?? null,
      monthlyPredicted: predicted, weeklyPredicted: weekly, weeklyUsed: weeklyOfficial ? used : week?.responses ?? null,
      weeklySource: weeklyOfficial ? 'official usage' : 'dated response records',
      forecast: used === null ? null : used + remaining,
      percentage: used === null || !predicted ? null : used / predicted * 100,
      alert: predictionAlert(used, predicted), observedAt: currentReport?.observedAt.toISOString() ?? null,
      stale: !currentReport || now.getTime() - currentReport.observedAt.getTime() > REFRESH_MS * 2,
      comparisonStale: !weeklyOfficial && (!week || now.getTime() - week.observedAt.getTime() > REFRESH_MS * 2),
    }];
  }));
  const used = currentReport?.responses ?? null;
  const complete = used !== null && projects.every(p => byProject[p.id].forecast !== null);
  // Official organization total includes consumption by projects missing from the
  // local inventory. Preserve it instead of replacing it with a partial sum.
  const expectedAdditional = Object.values(byProject).reduce((sum, p) => sum + (p.forecast === null ? 0 : Math.max(0, p.forecast - p.used!)), 0);
  return {
    ...period, estimateWeekStart, estimateWeekEnd, remainingDays: remainingPlan(0, now, period.resetAt).days, timezone, limit: RESPONSE_LIMIT, used, remaining: used === null ? null : Math.max(0, RESPONSE_LIMIT - used),
    forecast: complete ? used! + expectedAdditional : null,
    providerLimit: currentReport?.providerLimit ?? null,
    stale: !currentReport || Object.values(byProject).some(p => p.stale), byProject, byMonitor,
  };
}

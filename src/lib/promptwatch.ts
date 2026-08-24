/** Thin client for the Promptwatch API v2. Mirrors the Python promptwatch_api.py. */
import { recordApiCall } from "./store";

const BASE_URL = process.env.PROMPTWATCH_BASE_URL || "https://server.promptwatch.com/api/v2";
const TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface PromptwatchProject {
  id: string;
  name: string;
  slug?: string;
  website?: string | null;
  createdAt?: string;
}

export interface PromptwatchMonitor {
  id: string;
  name: string;
  description?: string | null;
  active: boolean;
  models: string[];
  languageCode?: string;
  countryCode?: string;
  promptFrequency?: string | null;
  promptCount?: number;
  responseCount?: number;
  averageVisibility?: number;
  updatedAt?: string;
  [key: string]: unknown;
}

export class PromptwatchClient {
  constructor(private apiKey: string) {}

  private async request<T>(
    method: string,
    path: string,
    opts: { params?: Record<string, string | number | undefined>; body?: unknown; projectId?: string } = {}
  ): Promise<T> {
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Promptwatch-Scheduler/1.0)",
    };
    if (opts.projectId) headers["X-Project-Id"] = opts.projectId;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const started = Date.now();
    let status = 0;
    let errorMsg: string | undefined;

    try {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
      status = res.status;
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;

      if (!res.ok) {
        const code = parsed?.code;
        errorMsg = parsed?.message || parsed?.error || text.slice(0, 300) || res.statusText;
        throw new ApiError(status, errorMsg ?? "Unknown error", code);
      }
      return parsed as T;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      status = 0;
      errorMsg = `Network error: ${(err as Error).message}`;
      throw new ApiError(0, errorMsg);
    } finally {
      clearTimeout(timeout);
      await recordApiCall(method, path, status, Date.now() - started, errorMsg);
    }
  }

  async listProjects(): Promise<PromptwatchProject[]> {
    const data = await this.request<{ projects: PromptwatchProject[] }>("GET", "/projects");
    return data?.projects ?? [];
  }

  async listMonitors(projectId: string, startDate?: string, endDate?: string): Promise<PromptwatchMonitor[]> {
    const data = await this.request<PromptwatchMonitor[]>("GET", "/monitors", {
      params: { startDate, endDate },
      projectId,
    });
    return data ?? [];
  }

  async getMonitor(projectId: string, monitorId: string): Promise<PromptwatchMonitor> {
    return this.request<PromptwatchMonitor>("GET", `/monitors/${monitorId}`, { projectId });
  }

  async setMonitorActive(projectId: string, monitorId: string, active: boolean): Promise<PromptwatchMonitor> {
    return this.request<PromptwatchMonitor>("PUT", `/monitors/${monitorId}`, {
      body: { active },
      projectId,
    });
  }

  async listPromptsPage(projectId: string, page = 1, size = 100) {
    return this.request<{ prompts: Array<{ llmMonitorId?: string; llmMonitor?: { id: string; name: string } }>; totalPages?: number }>(
      "GET",
      "/prompts",
      { params: { page, size }, projectId }
    );
  }

  /** Every distinct monitor with at least one prompt in this project, active or not —
   * /monitors only returns active monitors, but /prompts isn't filtered by monitor status. */
  async iterProjectMonitorIds(projectId: string, pageSize = 100, maxPages = 200): Promise<Map<string, string | undefined>> {
    const seen = new Map<string, string | undefined>();
    let page = 1;
    while (page <= maxPages) {
      const data = await this.listPromptsPage(projectId, page, pageSize);
      for (const prompt of data?.prompts ?? []) {
        const monitor: { id?: string; name?: string } = prompt.llmMonitor ?? {};
        const monitorId = prompt.llmMonitorId ?? monitor.id;
        if (monitorId) seen.set(monitorId, monitor.name);
      }
      const totalPages = data?.totalPages ?? 1;
      if (page >= totalPages) break;
      page += 1;
    }
    return seen;
  }
}

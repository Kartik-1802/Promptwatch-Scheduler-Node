import { refreshResponseUsage } from './responses';

export const USAGE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** Independent of dashboard visits and the monitor scheduler's enabled setting. */
export function startResponseUsageLoop(
  refresh = refreshResponseUsage,
  reportError: (error: unknown) => void = error => console.error('Response usage refresh:', error),
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    const started = Date.now();
    try {
      const result = await refresh();
      if (result.errors.length) reportError(result.errors.join('; '));
    } catch (error) {
      reportError(error);
    } finally {
      if (!stopped) timer = setTimeout(run, Math.max(0, USAGE_REFRESH_INTERVAL_MS - (Date.now() - started)));
    }
  };
  void run();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

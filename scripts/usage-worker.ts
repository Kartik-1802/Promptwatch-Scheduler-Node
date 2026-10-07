/** Local usage-only worker: reads Promptwatch counters without toggling monitors. */
import { prisma } from '../src/lib/db';
import { startResponseUsageLoop } from '../src/lib/response-usage-loop';
const stop = startResponseUsageLoop();
console.log('Response usage worker running; refreshes every hour.');
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    stop();
    await prisma.$disconnect();
    process.exit(0);
  });
}

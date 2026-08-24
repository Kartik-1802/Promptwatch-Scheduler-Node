/** Background worker: seeds the super admin account, then runs the scheduler tick
 * loop forever. Runs as its own process (see docker-compose.yml's `worker` service)
 * so it's independent of the Next.js request/response lifecycle and its edge/node
 * dual bundling — a plain, long-running Node script talking to the same Postgres
 * database as the web app. Run with: npx tsx scripts/worker.ts */
import { ensureSuperAdmin } from "../src/lib/auth";
import { prisma } from "../src/lib/db";
import { startSchedulerLoop } from "../src/lib/scheduler";
import { log } from "../src/lib/store";

async function main() {
  await ensureSuperAdmin();
  await log("info", "server", "Scheduler worker started");
  startSchedulerLoop();
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});

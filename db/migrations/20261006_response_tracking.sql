-- Additive only: existing monitors, schedules, and usage history are untouched.
CREATE TABLE IF NOT EXISTS "ResponseAllocation" (
  "projectId" TEXT NOT NULL,
  "cycleStart" TEXT NOT NULL,
  "responses" INTEGER NOT NULL,
  "importance" TEXT NOT NULL DEFAULT 'normal',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResponseAllocation_pkey" PRIMARY KEY ("projectId", "cycleStart")
);
CREATE TABLE IF NOT EXISTS "ResponseUsage" (
  "timezone" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "start" TEXT NOT NULL,
  "end" TEXT NOT NULL,
  "responses" INTEGER NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResponseUsage_pkey" PRIMARY KEY ("projectId", "start", "end", "timezone")
);
CREATE TABLE IF NOT EXISTS "ResponseUsageReport" (
  "periodFrom" TIMESTAMP(3) NOT NULL,
  "periodTo" TIMESTAMP(3) NOT NULL,
  "responses" INTEGER NOT NULL,
  "providerLimit" INTEGER NOT NULL,
  "projects" JSONB NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResponseUsageReport_pkey" PRIMARY KEY ("periodFrom")
);

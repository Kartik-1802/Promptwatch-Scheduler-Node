CREATE TABLE IF NOT EXISTS "ResponseFormula" (
  "projectId" TEXT NOT NULL,
  "baseResponses" INTEGER,
  "runsPerWeek" INTEGER,
  "weeksPerMonth" INTEGER NOT NULL DEFAULT 4,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResponseFormula_pkey" PRIMARY KEY ("projectId")
);

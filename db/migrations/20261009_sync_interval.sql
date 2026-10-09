ALTER TABLE "Settings" ALTER COLUMN "tickSeconds" SET DEFAULT 180;
UPDATE "Settings" SET "tickSeconds" = 180 WHERE "tickSeconds" = 60;

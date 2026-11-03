-- Explicit account opt-in; older applications ignore the added column.
ALTER TABLE "user" ADD COLUMN "taskContinuityEnabled" BOOLEAN NOT NULL DEFAULT false;

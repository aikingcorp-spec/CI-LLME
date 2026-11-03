-- External secret-store references can remain constant while their contents change.
-- Previous application versions omit this column and retain their insert behavior.
ALTER TABLE "user_integration_provider_configs"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

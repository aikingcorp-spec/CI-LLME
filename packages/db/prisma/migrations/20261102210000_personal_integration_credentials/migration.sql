-- Additive; previous API/worker versions do not read this table.
CREATE TABLE "user_integration_provider_configs" (
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("userId", "provider")
);
ALTER TABLE "user_integration_provider_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_integration_provider_configs" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_integration_provider_configs_tenant ON "user_integration_provider_configs"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_integration_provider_configs_system ON "user_integration_provider_configs"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

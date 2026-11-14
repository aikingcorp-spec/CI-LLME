-- Additive: the previous release never reads this table.
CREATE TABLE "user_integration_provider_configs" (
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "revision" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("userId", "provider"),
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
ALTER TABLE "user_integration_provider_configs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY personal_integration_tenant ON "user_integration_provider_configs"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY personal_integration_system ON "user_integration_provider_configs"
  USING (current_setting('app.rls_bypass', true) = 'on');

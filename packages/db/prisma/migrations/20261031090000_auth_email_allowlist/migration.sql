-- Additive: the previous release never reads this table.
CREATE TABLE "auth_email_allowlist" (
    "email" TEXT NOT NULL,
    "note" TEXT,
    "addedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_email_allowlist_pkey" PRIMARY KEY ("email"),
    CONSTRAINT "auth_email_allowlist_email_normalized" CHECK ("email" = lower(regexp_replace(normalize(btrim("email"), NFC), '[\u200B\u200C\u200D\u2060\uFEFF]', '', 'g')) AND "email" LIKE '%_@_%')
);
-- System-only table: no tenant policy. FORCE so even the table owner goes
-- through the policy; reads and writes both need the system bypass.
ALTER TABLE "auth_email_allowlist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_email_allowlist" FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_email_allowlist_system ON "auth_email_allowlist"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

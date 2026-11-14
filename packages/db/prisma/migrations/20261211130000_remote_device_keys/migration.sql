-- Additive: older releases never read or write this table.
CREATE TABLE "remote_device_keys" (
    "deviceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "remote_device_keys_pkey" PRIMARY KEY ("deviceId")
);

CREATE INDEX "remote_device_keys_accountId_idx" ON "remote_device_keys"("accountId");

ALTER TABLE "remote_device_keys" ADD CONSTRAINT "remote_device_keys_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "remote_device_keys" TO rakazo_app;
  END IF;
END $$;

-- System only. A tenant connection cannot read or replace another account's device key.
ALTER TABLE "remote_device_keys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY remote_device_keys_system ON "remote_device_keys"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

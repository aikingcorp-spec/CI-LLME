-- Additive: older releases never read or write this table.
CREATE TABLE "remote_hosts" (
    "deviceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "remoteEnabled" BOOLEAN NOT NULL DEFAULT false,
    "heartbeatAt" TIMESTAMP(3),
    "providerError" BOOLEAN NOT NULL DEFAULT false,
    "providerObjectId" TEXT,
    "logicalHost" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "remote_hosts_pkey" PRIMARY KEY ("deviceId")
);

CREATE INDEX "remote_hosts_accountId_remoteEnabled_idx" ON "remote_hosts"("accountId", "remoteEnabled");

ALTER TABLE "remote_hosts" ADD CONSTRAINT "remote_hosts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "remote_hosts" TO rakazo_app;
  END IF;
END $$;

-- System only. A tenant connection cannot read or change another account's seat.
ALTER TABLE "remote_hosts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY remote_hosts_system ON "remote_hosts"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

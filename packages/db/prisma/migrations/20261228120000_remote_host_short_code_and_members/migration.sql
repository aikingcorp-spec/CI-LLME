-- Additive, non-deferred: rolling release safe.
ALTER TABLE "remote_hosts" ADD COLUMN "shortCode" TEXT;

DO $$
DECLARE
  rec RECORD;
  chars CONSTANT TEXT := 'abcdefghijklmnopqrstuvwxyz0123456789';
  candidate TEXT;
  attempt INT;
  h BYTEA;
  i INT;
BEGIN
  FOR rec IN SELECT "deviceId" FROM "remote_hosts" WHERE "shortCode" IS NULL ORDER BY "deviceId" LOOP
    attempt := 0;
    LOOP
      h := decode(md5(rec."deviceId" || ':' || attempt::text), 'hex');
      candidate := '';
      FOR i IN 0..7 LOOP
        candidate := candidate || substr(chars, (get_byte(h, i) % 36) + 1, 1);
      END LOOP;
      IF NOT EXISTS (SELECT 1 FROM "remote_hosts" WHERE "shortCode" = candidate) THEN
        UPDATE "remote_hosts" SET "shortCode" = candidate WHERE "deviceId" = rec."deviceId";
        EXIT;
      END IF;
      attempt := attempt + 1;
    END LOOP;
  END LOOP;
END $$;

CREATE UNIQUE INDEX "remote_hosts_shortCode_key" ON "remote_hosts"("shortCode");

CREATE TABLE "remote_host_members" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remote_host_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "remote_host_members_deviceId_accountId_key" ON "remote_host_members"("deviceId", "accountId");
CREATE INDEX "remote_host_members_accountId_idx" ON "remote_host_members"("accountId");

ALTER TABLE "remote_host_members" ADD CONSTRAINT "remote_host_members_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "remote_hosts"("deviceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "remote_host_members" ADD CONSTRAINT "remote_host_members_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "remote_host_members" TO rakazo_app;
  END IF;
END $$;

ALTER TABLE "remote_host_members" ENABLE ROW LEVEL SECURITY;
CREATE POLICY remote_host_members_system ON "remote_host_members"
  USING ((SELECT app_rls_bypass()));

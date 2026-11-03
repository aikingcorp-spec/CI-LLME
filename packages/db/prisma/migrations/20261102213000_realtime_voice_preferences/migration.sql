CREATE TABLE "user_realtime_voice_preferences" (
  "userId" TEXT NOT NULL PRIMARY KEY,
  "credentialId" TEXT NOT NULL,
  "voiceId" TEXT NOT NULL DEFAULT 'cove',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  FOREIGN KEY ("credentialId", "userId") REFERENCES "user_model_credentials"("id", "userId") ON DELETE CASCADE
);
ALTER TABLE "user_realtime_voice_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_realtime_voice_preferences" FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_voice_tenant ON "user_realtime_voice_preferences"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY realtime_voice_system ON "user_realtime_voice_preferences"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

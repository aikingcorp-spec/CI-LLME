-- Route the VNBot system-only policies through the same key check as every other bypass policy.
-- The release before this one already reads these tables through runAsSystem, which sends the key.
DROP POLICY IF EXISTS auth_email_allowlist_system ON "auth_email_allowlist";
CREATE POLICY auth_email_allowlist_system ON "auth_email_allowlist"
  USING ((SELECT app_rls_bypass()));

DROP POLICY IF EXISTS remote_hosts_system ON "remote_hosts";
CREATE POLICY remote_hosts_system ON "remote_hosts"
  USING ((SELECT app_rls_bypass()));

DROP POLICY IF EXISTS remote_device_keys_system ON "remote_device_keys";
CREATE POLICY remote_device_keys_system ON "remote_device_keys"
  USING ((SELECT app_rls_bypass()));

DROP POLICY IF EXISTS realtime_voice_system ON "user_realtime_voice_preferences";
CREATE POLICY realtime_voice_system ON "user_realtime_voice_preferences"
  USING ((SELECT app_rls_bypass()));

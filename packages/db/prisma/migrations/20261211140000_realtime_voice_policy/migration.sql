ALTER POLICY realtime_voice_system ON "user_realtime_voice_preferences"
  USING ((SELECT app_rls_bypass()))
  WITH CHECK ((SELECT app_rls_bypass()));

import { credentialIssue } from "@rakazo/core";
import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../components/native-action-button";
import type { PasswordResetCapabilities } from "../lib/api";
import {
  currentApiBase,
  displayApiHost,
  loadSessionToken,
  passwordResetCapabilities,
  rpc,
  sendSignInCode,
  signInWithCode,
  usesCustomApiBase,
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { hasIncomingShare } from "../lib/incoming-share";
import { useMobileTokens } from "../lib/native";
import { passkeysAvailable, signInWithPasskey } from "../lib/passkey";
import { continueWithSso } from "../lib/sso";
import { credentialIssueText, errorText } from "../lib/user-error";

const CODE_LENGTH = 6;

export default function SignIn() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [apiBase, setApiBase] = useState(() => currentApiBase());
  const [capabilities, setCapabilities] = useState<PasswordResetCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState(false);
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [passkeys, setPasskeys] = useState(false);

  useFocusEffect(useCallback(() => setApiBase(currentApiBase()), []));
  useEffect(() => {
    void loadSessionToken().then((token) => {
      setHasSession(Boolean(token));
      setReady(true);
    });
  }, []);
  useEffect(() => {
    let active = true;
    setCapabilities(null);
    setCapabilityError(false);
    setCodeSent(false);
    setCode("");
    void passwordResetCapabilities()
      .then((value) => {
        if (active) setCapabilities(value);
      })
      .catch(() => {
        if (active) setCapabilityError(true);
      });
    return () => {
      active = false;
    };
  }, [apiBase, capabilityAttempt]);
  useEffect(() => {
    let active = true;
    setPasskeys(false);
    void passkeysAvailable(capabilities).then((available) => {
      if (active) setPasskeys(available);
    });
    return () => {
      active = false;
    };
  }, [capabilities]);
  useEffect(() => {
    if (codeSent) AccessibilityInfo.announceForAccessibility(t("Check your email"));
  }, [codeSent, t]);

  async function openApp() {
    if (hasIncomingShare()) return router.replace("/share");
    const me = await rpc("me").catch(() => null);
    router.replace(me?.needsSignupSurvey ? "/signup-survey" : "/");
  }

  async function submit(enteredCode = code) {
    if (pending || !capabilities?.emailCode) return;
    const issue = credentialIssue({ email });
    if (issue) {
      setError(credentialIssueText(issue));
      return;
    }
    if (codeSent && enteredCode.length !== CODE_LENGTH) return;
    setPending(true);
    setError(null);
    try {
      const trimmed = email.trim();
      if (!codeSent) {
        const sentFrom = apiBase;
        await sendSignInCode(trimmed);
        if (currentApiBase() !== sentFrom) return;
        setCode("");
        setCodeSent(true);
      } else {
        await signInWithCode(trimmed, enteredCode, trimmed.split("@")[0] || "User");
        await openApp();
      }
    } catch (cause) {
      setError(errorText(cause, t("Could not continue")));
    } finally {
      setPending(false);
    }
  }

  async function externalSignIn(run: () => Promise<boolean>) {
    setPending(true);
    setError(null);
    try {
      if (await run()) await openApp();
    } catch (cause) {
      setError(errorText(cause, t("Could not continue")));
    } finally {
      setPending(false);
    }
  }

  if (!ready) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          justifyContent: "center",
          padding: 24,
        }}
      >
        <ActivityIndicator color={tokens.mutedForeground} accessibilityLabel={t("Loading…")} />
      </View>
    );
  }
  if (hasSession) return <Redirect href={hasIncomingShare() ? "/share" : "/"} />;
  const custom = usesCustomApiBase(apiBase);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
          <View style={{ flex: 1 }}>
            <ScrollView
              contentContainerStyle={{
                flexGrow: 1,
                justifyContent: "center",
                paddingHorizontal: 24,
                paddingVertical: 24,
              }}
              keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
              keyboardShouldPersistTaps="handled"
            >
              <Text
                accessibilityRole="header"
                style={{
                  color: tokens.foreground,
                  fontSize: 32,
                  fontWeight: "500",
                  textAlign: "center",
                }}
              >
                {codeSent ? t("Check your email") : t("Sign in to VNBot")}
              </Text>
              {capabilityError ? (
                <View accessibilityRole="alert">
                  <Text style={{ color: tokens.destructive }}>
                    {t("Could not load sign-in options")}
                  </Text>
                  <NativeActionButton
                    label={t("Retry")}
                    onPress={() => setCapabilityAttempt((value) => value + 1)}
                  />
                </View>
              ) : !capabilities ? (
                <ActivityIndicator
                  color={tokens.mutedForeground}
                  accessibilityLabel={t("Loading…")}
                  style={{ marginTop: 16 }}
                />
              ) : null}
              {capabilities?.emailCode ? (
                codeSent ? (
                  <>
                    <TextInput
                      accessibilityLabel={t("Code")}
                      autoComplete="one-time-code"
                      autoFocus
                      keyboardType="number-pad"
                      maxLength={CODE_LENGTH}
                      placeholder={t("Code")}
                      placeholderTextColor={tokens.mutedForeground}
                      textContentType="oneTimeCode"
                      value={code}
                      onChangeText={(value) => {
                        const digits = value.replace(/\D/g, "").slice(0, CODE_LENGTH);
                        setCode(digits);
                        if (digits.length === CODE_LENGTH) void submit(digits);
                      }}
                      onSubmitEditing={() => void submit()}
                      style={{
                        marginTop: 28,
                        backgroundColor: tokens.muted,
                        borderRadius: 13,
                        padding: 16,
                        color: tokens.foreground,
                      }}
                    />
                    {error ? (
                      <Text
                        accessibilityRole="alert"
                        style={{ color: tokens.destructive, marginTop: 12 }}
                      >
                        {error}
                      </Text>
                    ) : null}
                    <NativeActionButton
                      disabled={pending || code.length < CODE_LENGTH}
                      label={pending ? t("Working…") : t("Continue")}
                      onPress={() => void submit()}
                      style={{ marginTop: 16 }}
                    />
                    <NativeActionButton
                      label={t("Back")}
                      prominence="quiet"
                      disabled={pending}
                      onPress={() => {
                        setCodeSent(false);
                        setCode("");
                        setError(null);
                      }}
                      style={{ alignSelf: "center", marginTop: 16 }}
                    />
                  </>
                ) : (
                  <>
                    <TextInput
                      autoCapitalize="none"
                      autoComplete="email"
                      keyboardType="email-address"
                      placeholder={t("Email")}
                      placeholderTextColor={tokens.mutedForeground}
                      value={email}
                      onChangeText={setEmail}
                      style={{
                        marginTop: 28,
                        backgroundColor: tokens.muted,
                        borderRadius: 13,
                        padding: 16,
                        color: tokens.foreground,
                      }}
                    />
                    {error ? (
                      <Text
                        accessibilityRole="alert"
                        style={{ color: tokens.destructive, marginTop: 12 }}
                      >
                        {error}
                      </Text>
                    ) : null}
                    <NativeActionButton
                      disabled={pending}
                      label={pending ? t("Working…") : t("Continue")}
                      onPress={() => void submit()}
                      style={{ marginTop: 16 }}
                    />
                  </>
                )
              ) : null}
              {capabilities && !capabilities.emailCode && !capabilities.sso ? (
                <Text
                  accessibilityRole="alert"
                  style={{ color: tokens.destructive, marginTop: 16 }}
                >
                  {t("Email sign-in is unavailable on this server")}
                </Text>
              ) : null}
              {passkeys ? (
                <NativeActionButton
                  label={t("Sign in with passkey")}
                  icon={{ ios: "key.fill", android: "key-outline" }}
                  prominence="secondary"
                  fill
                  disabled={pending}
                  onPress={() => void externalSignIn(signInWithPasskey)}
                  style={{ marginTop: 12 }}
                />
              ) : null}
              {capabilities?.sso ? (
                <NativeActionButton
                  label={t("Continue with {name}", { name: capabilities.sso.name })}
                  prominence={capabilities.emailCode ? "quiet" : "primary"}
                  disabled={pending}
                  onPress={() => void externalSignIn(continueWithSso)}
                  style={{ alignSelf: "center", marginTop: 16 }}
                />
              ) : null}
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                custom
                  ? t("Custom server {host}", { host: displayApiHost(apiBase) })
                  : t("Use a custom server")
              }
              hitSlop={12}
              onPress={() => router.push("/server")}
              style={{
                alignItems: "center",
                paddingHorizontal: 24,
                paddingBottom: 12,
                paddingTop: 8,
              }}
            >
              {custom ? (
                <>
                  <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
                    {t("Custom server")}
                  </Text>
                  <Text style={{ color: tokens.mutedForeground, fontSize: 13, marginTop: 2 }}>
                    {displayApiHost(apiBase)}
                  </Text>
                </>
              ) : (
                <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
                  {t("Use a custom server")}
                </Text>
              )}
            </Pressable>
          </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

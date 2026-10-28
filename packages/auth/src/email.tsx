/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { displayName } from "@rakazo/core";
import { lightTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { Body, Container, Head, Html, Link, render, Text, toPlainText } from "react-email";
import {
  SIGN_IN_CODE_EN_HTML,
  SIGN_IN_CODE_EN_TXT,
  SIGN_IN_CODE_VI_HTML,
  SIGN_IN_CODE_VI_TXT,
} from "./sign-in-code-templates.js";

export async function message(
  to: string,
  subject: string,
  content: ReactNode,
  headers?: Record<string, string>,
): Promise<TransactionalEmail> {
  const html = await render(
    <Html lang="en">
      <Head />
      <Body
        style={{
          backgroundColor: lightTokens.dialog,
          color: lightTokens.foreground,
          fontFamily: "Arial, sans-serif",
        }}
      >
        <Container style={{ maxWidth: "480px", padding: "24px" }}>{content}</Container>
      </Body>
    </Html>,
  );
  return { to, subject, html, text: toPlainText(html), ...(headers ? { headers } : {}) };
}

export const linkStyle = { color: lightTokens.primary, textDecoration: "underline" };

export function verificationEmail(email: string, url: string): Promise<TransactionalEmail> {
  return message(
    email,
    "Verify your Rakazo email",
    <>
      <Text>
        <Link href={url} style={linkStyle}>
          Verify email
        </Link>
      </Text>
      <Text>Then return to Rakazo to sign in.</Text>
      <Text>This link expires in one hour. If you did not register, ignore this email.</Text>
    </>,
  );
}

const SIGN_IN_CODE_SUBJECT = {
  vi: "Mã đăng nhập VNBot của bạn",
  en: "Your VNBot sign-in code",
} as const;

/** Vietnamese unless the caller passed English (`en` or `en-…`). */
export function signInCodeLocale(raw: string | null | undefined): "vi" | "en" {
  const value = raw?.trim().toLowerCase().replaceAll("_", "-") ?? "";
  if (value === "en" || value.startsWith("en-")) return "en";
  return "vi";
}

/** Public URL prefix for `vnbot-wordmark-light@2x.png`, served by the web app. */
export function signInCodeAssetBase(webOrigin: string): string {
  return `${webOrigin.replace(/\/$/, "")}/email`;
}

export function signInCodeEmail(
  email: string,
  code: string,
  options?: { locale?: string | null; assetBase?: string },
): Promise<TransactionalEmail> {
  const locale = signInCodeLocale(options?.locale);
  const values = { CODE: code, EMAIL: email, ASSET_BASE: options?.assetBase ?? "" };
  const htmlTemplate = locale === "en" ? SIGN_IN_CODE_EN_HTML : SIGN_IN_CODE_VI_HTML;
  const textTemplate = locale === "en" ? SIGN_IN_CODE_EN_TXT : SIGN_IN_CODE_VI_TXT;
  return Promise.resolve({
    to: email,
    subject: SIGN_IN_CODE_SUBJECT[locale],
    html: fillTemplate(htmlTemplate, values, true),
    text: fillTemplate(textTemplate, values, false).trimEnd(),
  });
}

function fillTemplate(template: string, values: Record<string, string>, html: boolean): string {
  return template.replaceAll(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => {
    const value = values[key];
    if (value === undefined) return match;
    return html ? escapeHtml(value) : value;
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function passwordResetEmail(
  user: { id: string; email: string; name: string },
  resetUrl: string,
): Promise<TransactionalEmail> {
  return message(
    user.email,
    "Reset your Rakazo password",
    <>
      <Text>Hi {displayName(user.name, "there")},</Text>
      <Text>Reset your Rakazo password:</Text>
      <Text>
        <Link href={resetUrl} style={linkStyle}>
          Reset password
        </Link>
      </Text>
      <Text>
        This link expires in one hour. If you did not request this, you can ignore this email.
      </Text>
    </>,
  );
}

export function accountDeletionEmail(email: string, code: string): Promise<TransactionalEmail> {
  return message(
    email,
    "Confirm Rakazo account deletion",
    <>
      <Text>Enter this code in Rakazo to delete your account:</Text>
      <Text>{code}</Text>
      <Text>
        This code expires in ten minutes. If you did not request deletion, ignore this email.
      </Text>
    </>,
  );
}

export function identityCodeEmail(email: string, code: string): Promise<TransactionalEmail> {
  return message(
    email,
    "Your Rakazo confirmation code",
    <>
      <Text>Enter this code in Rakazo to confirm it's you:</Text>
      <Text>
        <strong>{code}</strong>
      </Text>
      <Text>This code expires in ten minutes. If you did not request it, ignore this email.</Text>
    </>,
  );
}

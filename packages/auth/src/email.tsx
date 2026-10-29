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
    <Html lang="vi">
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

/** Every product email signs off as the team, never as a person or another product. */
export const EMAIL_SIGNATURE = "Đội VNBot";

export const linkStyle = { color: lightTokens.primary, textDecoration: "underline" };

export function verificationEmail(email: string, url: string): Promise<TransactionalEmail> {
  return message(
    email,
    "Xác minh email VNBot của bạn",
    <>
      <Text>
        <Link href={url} style={linkStyle}>
          Xác minh email
        </Link>
      </Text>
      <Text>Sau đó quay lại VNBot để đăng nhập.</Text>
      <Text>Liên kết hết hạn sau một giờ. Nếu bạn không đăng ký, hãy bỏ qua email này.</Text>
      <Text>{EMAIL_SIGNATURE}</Text>
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
    "Đặt lại mật khẩu VNBot",
    <>
      <Text>Chào {displayName(user.name, "bạn")},</Text>
      <Text>Đặt lại mật khẩu VNBot của bạn:</Text>
      <Text>
        <Link href={resetUrl} style={linkStyle}>
          Đặt lại mật khẩu
        </Link>
      </Text>
      <Text>Liên kết hết hạn sau một giờ. Nếu bạn không yêu cầu, hãy bỏ qua email này.</Text>
      <Text>{EMAIL_SIGNATURE}</Text>
    </>,
  );
}

export function accountDeletionEmail(email: string, code: string): Promise<TransactionalEmail> {
  return message(
    email,
    "Xác nhận xóa tài khoản VNBot",
    <>
      <Text>Nhập mã này trong VNBot để xóa tài khoản:</Text>
      <Text>{code}</Text>
      <Text>Mã hết hạn sau mười phút. Nếu bạn không yêu cầu xóa, hãy bỏ qua email này.</Text>
      <Text>{EMAIL_SIGNATURE}</Text>
    </>,
  );
}

export function identityCodeEmail(email: string, code: string): Promise<TransactionalEmail> {
  return message(
    email,
    "Mã xác nhận VNBot của bạn",
    <>
      <Text>Nhập mã này trong VNBot để xác nhận đó là bạn:</Text>
      <Text>
        <strong>{code}</strong>
      </Text>
      <Text>Mã hết hạn sau mười phút. Nếu bạn không yêu cầu, hãy bỏ qua email này.</Text>
      <Text>{EMAIL_SIGNATURE}</Text>
    </>,
  );
}

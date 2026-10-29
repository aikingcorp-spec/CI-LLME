/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { displayName } from "@rakazo/core";
import { lightTokens } from "@rakazo/ui-tokens";
import { Hr, Link, Text } from "react-email";
import { message } from "./email.js";

export function welcomeEmail(
  user: { email: string; name: string },
  unsubscribeUrl: string,
): Promise<TransactionalEmail> {
  return message(
    user.email,
    "Chào mừng đến với VNBot",
    <>
      <Text>Chào {displayName(user.name, "bạn")},</Text>
      <Text>Cảm ơn bạn đã đăng ký VNBot. Cần giúp gì, bạn cứ trả lời email này.</Text>
      <Text>
        Hi {displayName(user.name, "there")}, thanks for signing up for VNBot. Questions? Reply to
        this email.
      </Text>
      <Text>Đội VNBot</Text>
      <Hr style={{ borderColor: lightTokens.border, marginTop: "32px" }} />
      <Text style={{ color: lightTokens.mutedForeground, fontSize: "12px" }}>
        <Link href={unsubscribeUrl} style={{ color: lightTokens.mutedForeground }}>
          Hủy đăng ký / Unsubscribe
        </Link>
      </Text>
    </>,
    {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  );
}

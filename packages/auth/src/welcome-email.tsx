/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { displayName } from "@rakazo/core";
import { lightTokens } from "@rakazo/ui-tokens";
import { Hr, Link, Text } from "react-email";
import { EMAIL_SIGNATURE, message } from "./email.js";

export function welcomeEmail(
  user: { email: string; name: string },
  unsubscribeUrl: string,
): Promise<TransactionalEmail> {
  return message(
    user.email,
    "Chào mừng bạn đến với VNBot",
    <>
      <Text>Chào {displayName(user.name, "bạn")},</Text>
      <Text>Cảm ơn bạn đã đăng ký VNBot, đội nhân viên AI của riêng bạn.</Text>
      <Text>
        VNBot chạy trên máy hoặc máy chủ của bạn. Chat và dữ liệu nằm ở đó, không nằm trên máy chủ
        của VNBot.
      </Text>
      <Text>Có câu hỏi hay góp ý? Bạn cứ trả lời email này.</Text>
      <Text>{EMAIL_SIGNATURE}</Text>
      <Hr style={{ borderColor: lightTokens.border, marginTop: "32px" }} />
      <Text style={{ color: lightTokens.mutedForeground, fontSize: "12px" }}>
        <Link href={unsubscribeUrl} style={{ color: lightTokens.mutedForeground }}>
          Hủy nhận email
        </Link>
      </Text>
    </>,
    {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  );
}

import { Trans } from "@lingui/react/macro";
import { cn } from "@rakazo/ui-web";
import { KeyRound, Lock, Users } from "lucide-react";

/** What joining a shared space means, shown once: on the invite, when someone agrees to it. */
export function SharedSpaceRules({ className }: { className?: string }) {
  return (
    <ul
      className={cn(
        "w-full space-y-3 rounded-xl border border-border px-4 py-3.5 text-start text-body text-muted-foreground",
        className,
      )}
    >
      <li className="flex items-center gap-3">
        <Users aria-hidden="true" className="size-4 shrink-0 text-foreground" />
        <Trans>Thành viên cùng thấy các cuộc trò chuyện, bot và trí nhớ ở đây</Trans>
      </li>
      <li className="flex items-center gap-3">
        <Lock aria-hidden="true" className="size-4 shrink-0 text-foreground" />
        <Trans>Các không gian khác của bạn vẫn riêng tư</Trans>
      </li>
      <li className="flex items-center gap-3">
        <KeyRound aria-hidden="true" className="size-4 shrink-0 text-foreground" />
        <Trans>Bot dùng tài khoản ứng dụng của người đang nhắn</Trans>
      </li>
    </ul>
  );
}

/// <reference path="./images.d.ts" />
import type { LogoAvatarActivity } from "@rakazo/core";
import { memo } from "react";
import ownerAvatar from "./assets/owner-avatar.png";
import { cn } from "./lib/utils.js";

/** Full owner master, preserved without cropping or recolouring. */
export const LogoAvatar = memo(function LogoAvatar({
  activity = "idle",
  size = 38,
  label,
  className,
}: {
  activity?: LogoAvatarActivity;
  size?: number;
  avatarValue?: string;
  identity?: string;
  label?: string;
  motion?: boolean;
  className?: string;
}) {
  return (
    <img
      src={ownerAvatar}
      alt={label ?? ""}
      width={size}
      height={size}
      data-activity={activity}
      className={cn("shrink-0 rounded-lg object-contain", className)}
    />
  );
});

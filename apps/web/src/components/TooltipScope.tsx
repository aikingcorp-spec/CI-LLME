import { TooltipProvider } from "@rakazo/ui-web/components/ui/tooltip";
import type { ReactNode } from "react";

export function TooltipScope({ children }: { children: ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

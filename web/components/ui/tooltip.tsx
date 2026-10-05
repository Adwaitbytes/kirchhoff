"use client";

import type { ComponentProps, ReactNode } from "react";
import { Tooltip as T } from "radix-ui";
import { cn } from "@/lib/utils";

export const TooltipProvider = T.Provider;

export function Tooltip({ content, children, side = "top", className }: { content: ReactNode; children: ReactNode; side?: ComponentProps<typeof T.Content>["side"]; className?: string }) {
  return (
    <T.Root delayDuration={250}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className={cn(
            "z-50 max-w-xs rounded-md border border-wire bg-raised px-2.5 py-1.5 text-xs text-fg shadow-pop data-[state=delayed-open]:animate-in",
            className,
          )}
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

"use client";

import type { ReactNode } from "react";
import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Sheet = D.Root;

export function SheetContent({ title, description, children, className, returnFocusTo }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string; returnFocusTo?: HTMLElement | null }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-black/40" />
      <D.Content
        onCloseAutoFocus={(e) => {
          // Opened from state rather than a Trigger: send focus back to whatever opened it.
          if (returnFocusTo && returnFocusTo.isConnected) {
            e.preventDefault();
            returnFocusTo.focus();
          }
        }}
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-[min(520px,100vw)] flex-col border-l border-wire bg-panel shadow-pop focus:outline-none",
          "data-[state=open]:animate-[sheet-in_220ms_cubic-bezier(0.25,1,0.5,1)]",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-wire px-5 py-4">
          <div className="min-w-0">
            <D.Title className="text-lg font-semibold tracking-[-0.01em]">{title}</D.Title>
            {description ? <D.Description className="mt-1 text-sm text-muted">{description}</D.Description> : null}
          </div>
          <D.Close className="-mr-1 rounded-md p-1 text-muted hover:bg-raised hover:text-fg" aria-label="Close">
            <X className="size-4" />
          </D.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </D.Content>
    </D.Portal>
  );
}

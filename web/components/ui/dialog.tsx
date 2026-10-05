"use client";

import type { ReactNode } from "react";
import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({ title, description, children, className, hideTitle = false }: { title: string; description?: string; children: ReactNode; className?: string; hideTitle?: boolean }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_150ms_ease-out]" />
      <D.Content
        className={cn(
          "fixed left-1/2 top-[12vh] z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 rounded-xl border border-wire bg-panel shadow-pop focus:outline-none",
          className,
        )}
      >
        <div className={cn("flex items-start justify-between gap-4 border-b border-wire px-5 py-4", hideTitle && "sr-only")}>
          <div>
            <D.Title className="text-base font-semibold tracking-[-0.01em]">{title}</D.Title>
            {description ? <D.Description className="mt-1 text-sm text-muted">{description}</D.Description> : null}
          </div>
          <D.Close className="-mr-1 rounded-md p-1 text-muted hover:bg-raised hover:text-fg" aria-label="Close">
            <X className="size-4" />
          </D.Close>
        </div>
        {children}
      </D.Content>
    </D.Portal>
  );
}

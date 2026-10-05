"use client";

import type { ReactNode } from "react";
import { Tabs as T } from "radix-ui";
import { cn } from "@/lib/utils";

export const Tabs = T.Root;
export const TabsContent = T.Content;

export function TabsList({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  return (
    <T.List aria-label={label} className={cn("inline-flex items-center gap-0.5 rounded-md border border-wire bg-inset p-0.5", className)}>
      {children}
    </T.List>
  );
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  return (
    <T.Trigger
      value={value}
      className="cursor-pointer rounded-[5px] px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-fg data-[state=active]:bg-raised data-[state=active]:text-fg data-[state=active]:shadow-[0_0_0_1px_var(--line-wire)]"
    >
      {children}
    </T.Trigger>
  );
}

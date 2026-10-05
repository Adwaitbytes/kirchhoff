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
      className="min-h-7 cursor-pointer rounded-[5px] px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-fg data-[state=active]:bg-raised data-[state=active]:text-fg data-[state=active]:shadow-[0_0_0_1px_var(--line-wire)]"
    >
      {children}
    </T.Trigger>
  );
}

/** A view switch (chart or table). Not tabs: no panels to control, so it is a pressed-state button group. */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex items-center gap-0.5 rounded-md border border-wire bg-inset p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "min-h-7 min-w-7 cursor-pointer rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
            value === o.value ? "bg-raised text-fg shadow-[0_0_0_1px_var(--line-wire)]" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

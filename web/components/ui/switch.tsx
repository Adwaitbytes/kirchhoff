"use client";

import { Switch as S } from "radix-ui";
import { cn } from "@/lib/utils";

export function Switch({ checked, onCheckedChange, label, className }: { checked: boolean; onCheckedChange: (v: boolean) => void; label: string; className?: string }) {
  return (
    <S.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      className={cn("relative h-5 w-9 shrink-0 cursor-pointer rounded-full border border-wire bg-inset transition-colors data-[state=checked]:border-transparent data-[state=checked]:bg-conserved", className)}
    >
      <S.Thumb className="block size-4 translate-x-0.5 rounded-full bg-fg shadow transition-transform duration-150 data-[state=checked]:translate-x-[17px] data-[state=checked]:bg-on-status" />
    </S.Root>
  );
}

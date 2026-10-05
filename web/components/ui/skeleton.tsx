import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** Sized like the content it stands in for (PRD section 12, Loading state). */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("skeleton", className)} {...props} />;
}

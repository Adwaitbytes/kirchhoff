"use client";

import type { ReactNode } from "react";
import { useHydrated } from "@/lib/api/hooks";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * App screens are fed entirely by client-side data, so their server HTML is a skeleton. The
 * interactive tree mounts after hydration: Radix ARIA ids (useId) are then generated once on the
 * client and can never disagree with server markup.
 */
export function ClientGate({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  const hydrated = useHydrated();
  if (!hydrated) return <>{fallback ?? <PageSkeleton />}</>;
  return <>{children}</>;
}

export function PageSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true">
      <div className="flex h-14 shrink-0 items-center gap-4 border-b border-wire px-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="hidden h-4 w-64 sm:block" />
      </div>
      <div className="grid flex-1 grid-cols-1 gap-3 p-4 lg:grid-cols-3">
        <Skeleton className="h-40 rounded-lg lg:col-span-3" />
        <Skeleton className="h-64 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Wand2 } from "lucide-react";
import { useTokens } from "@/lib/api/hooks";
import { EmptyState } from "@/components/kh/panel";
import { Banner } from "@/components/kh/banner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export default function AppIndex() {
  const tokens = useTokens();
  const router = useRouter();
  const first = tokens.data?.items[0];
  useEffect(() => {
    if (first) router.replace(`/app/tokens/${first.symbol}`);
  }, [first, router]);

  if (tokens.error) {
    return (
      <div className="p-6">
        <Banner tone="error">KIRCHHOFF API unreachable: {tokens.error.message}.</Banner>
      </div>
    );
  }
  if (tokens.data && tokens.data.items.length === 0) {
    return (
      <EmptyState
        icon={<Wand2 className="size-6" />}
        title="No protected tokens yet. Onboard your first token."
        action={
          <Button asChild variant="primary">
            <Link href="/app/onboard">Onboard a token</Link>
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex flex-1 flex-col gap-4 p-6" aria-busy="true">
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-[60vh] w-full rounded-lg" />
    </div>
  );
}

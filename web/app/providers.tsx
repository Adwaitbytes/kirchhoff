"use client";

import type { ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { ApiProvider } from "@/lib/api/provider";
import { PrefsProvider } from "@/lib/prefs";
import { wagmiConfig } from "@/lib/wagmi";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StageFrame } from "@/components/kh/stage-frame";
import { FixtureBar } from "@/components/kh/fixture-bar";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <PrefsProvider>
      <WagmiProvider config={wagmiConfig}>
        <ApiProvider>
          <TooltipProvider>
            <StageFrame>{children}</StageFrame>
            <FixtureBar />
          </TooltipProvider>
        </ApiProvider>
      </WagmiProvider>
    </PrefsProvider>
  );
}

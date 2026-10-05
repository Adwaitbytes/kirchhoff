"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Activity, FlaskConical, Globe, Moon, Plug, Server, Sparkles, Sun, Wand2 } from "lucide-react";
import { usePrefs } from "@/lib/prefs";
import { Tooltip } from "@/components/ui/tooltip";
import { LogoMark } from "@/components/shell/logo";
import { AskPalette } from "@/components/ask/ask-palette";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/app", match: "/app/tokens", label: "Mission Control", icon: Activity },
  { href: "/lab", match: "/lab", label: "Attack Lab", icon: FlaskConical },
  { href: "/app/onboard", match: "/app/onboard", label: "Onboard a token", icon: Wand2 },
  { href: "/app/ops", match: "/app/ops", label: "Verifier Ops", icon: Server },
  { href: "/app/integrate", match: "/app/integrate", label: "Integrations", icon: Plug },
  { href: "/t/kETH", match: "/t/", label: "Public status page", icon: Globe },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { theme, setTheme } = usePrefs();
  return (
    <div className="flex h-dvh min-h-0 w-full flex-col md:flex-row stage:h-full">
      <nav
        aria-label="Primary"
        className="surface-glass fixed inset-x-0 bottom-0 z-40 flex h-[60px] items-center justify-around border-t border-wire px-1 pb-[env(safe-area-inset-bottom)] md:static md:h-auto md:w-[60px] md:shrink-0 md:flex-col md:justify-start md:gap-1 md:border-r md:border-t-0 md:bg-panel md:px-0 md:py-3 md:backdrop-filter-none"
      >
        <Link href="/" aria-label="KIRCHHOFF home" className="hidden rounded-lg md:mb-3 md:block">
          <LogoMark />
        </Link>
        {NAV.map((item) => {
          const active = pathname.startsWith(item.match);
          const Icon = item.icon;
          return (
            <Tooltip key={item.href} content={item.label} side="right">
              <Link
                href={item.href}
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex size-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-fg md:size-10",
                  active &&
                    "bg-raised text-fg before:absolute before:-top-[9px] before:h-[2px] before:w-5 before:rounded-full before:bg-conserved before:shadow-[0_0_8px_var(--status-conserved)] md:before:-left-[10px] md:before:top-auto md:before:h-5 md:before:w-[2px]",
                )}
              >
                <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
              </Link>
            </Tooltip>
          );
        })}
        <div className="hidden md:mt-auto md:flex md:flex-col md:items-center md:gap-1">
          <Tooltip content="Ask KIRCHHOFF (⌘K)" side="right">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("kh:ask"))}
              aria-label="Ask KIRCHHOFF"
              className="flex size-10 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg"
            >
              <Sparkles className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content={theme === "dark" ? "Light theme" : "Dark theme"} side="right">
            <button
              type="button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              className="flex size-10 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg"
            >
              {theme === "dark" ? <Sun className="size-[18px]" strokeWidth={1.75} /> : <Moon className="size-[18px]" strokeWidth={1.75} />}
            </button>
          </Tooltip>
        </div>
      </nav>
      <div id="main" className="flex min-h-0 min-w-0 flex-1 flex-col pb-[60px] md:pb-0">
        {children}
      </div>
      <AskPalette />
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { usePrefs } from "@/lib/prefs";
import { LogoMark, Wordmark } from "@/components/shell/logo";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "#rules", label: "Two laws" },
  { href: "#live", label: "Live" },
  { href: "#replay", label: "Kelp Replay" },
  { href: "#chainlink", label: "Inside CCIP" },
];

export function LandingNav() {
  const { theme, setTheme } = usePrefs();
  const [progress, setProgress] = useState(0);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(max > 0 ? window.scrollY / max : 0);
      setScrolled(window.scrollY > 24);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      <div aria-hidden="true" className="fixed inset-x-0 top-0 z-50 h-[2px]">
        <div className="h-full origin-left bg-conserved shadow-[0_0_12px_var(--status-conserved)]" style={{ transform: `scaleX(${progress})` }} />
      </div>
      <div className="fixed inset-x-0 top-3 z-40 px-3 sm:top-4 sm:px-5">
        <nav
          aria-label="Site"
          className={cn(
            "mx-auto flex h-14 max-w-[1160px] items-center gap-4 rounded-2xl border bg-panel/70 px-3 pl-3.5 backdrop-blur-xl transition-[border-color,box-shadow,background-color] duration-300 sm:gap-6 sm:pl-4",
            scrolled ? "border-wire shadow-panel" : "border-transparent bg-transparent shadow-none backdrop-blur-0",
          )}
        >
          <Link href="/" className="flex items-center gap-2.5 rounded-lg" aria-label="KIRCHHOFF home">
            <LogoMark className="size-7" />
            <Wordmark className="hidden sm:inline" />
          </Link>
          <div className="ml-auto hidden items-center gap-6 md:flex">
            {LINKS.map((l) => (
              <a key={l.href} href={l.href} className="rounded-sm text-sm font-medium text-muted transition-colors hover:text-fg">
                {l.label}
              </a>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2 md:ml-0">
            <button
              type="button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              className="flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-fg"
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
            <Link
              href="/app"
              className="inline-flex h-9 items-center rounded-full bg-fg px-4 text-sm font-medium text-canvas shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_1px_2px_rgb(0_0_0/0.3)] transition-[transform,box-shadow] hover:-translate-y-px hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_8px_20px_-6px_color-mix(in_oklab,var(--status-conserved)_55%,transparent)]"
            >
              Mission Control
            </Link>
          </div>
        </nav>
      </div>
    </>
  );
}

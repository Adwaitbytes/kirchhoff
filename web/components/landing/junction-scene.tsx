"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import type { JunctionHandle } from "@/components/landing/junction-3d";

/**
 * Hosts the glass junction. three.js is imported only here, after mount, so it never weighs on
 * the first paint; a CSS poster of the same object holds the space until the first frame lands.
 */
export function JunctionScene({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const { theme, reducedMotion, motionScale } = usePrefs();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    let handle: JunctionHandle | null = null;
    let cancelled = false;
    setReady(false);
    import("@/components/landing/junction-3d")
      .then(({ mountJunction }) => {
        if (cancelled) return;
        handle = mountJunction({ canvas, theme, reducedMotion, motionScale, onReady: () => setReady(true) });
      })
      .catch((e: unknown) => {
        console.warn("Junction scene unavailable, keeping the poster", e);
        setFailed(true);
      });
    const onMove = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      handle?.setPointer(((e.clientX - r.left) / r.width - 0.5) * 2, ((e.clientY - r.top) / r.height - 0.5) * 2);
    };
    const io = new IntersectionObserver(([en]) => handle?.setVisible(en?.isIntersecting ?? true));
    io.observe(host);
    const onVis = () => handle?.setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    if (!reducedMotion) window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      cancelled = true;
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onMove);
      handle?.dispose();
    };
  }, [theme, reducedMotion, motionScale]);

  return (
    <div ref={hostRef} className={cn("relative", className)} aria-hidden="true">
      {/* Poster: the junction in CSS, visible until WebGL draws (and forever if it cannot). */}
      <div className={cn("pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-700", ready && !failed ? "opacity-0" : "opacity-100")}>
        <div className="relative -mt-[6%] aspect-square w-[40%] max-w-[320px] rounded-[20%] border-[18px] border-[#2b3134] light:border-white bg-[linear-gradient(140deg,color-mix(in_oklab,var(--mint)_28%,transparent),color-mix(in_oklab,#1d6250_18%,transparent))] shadow-[0_40px_70px_-36px_rgb(17_60_40/0.5)]">
          <svg viewBox="0 0 32 32" className="absolute inset-[8%] text-mint" fill="none">
            <path d="M16 15 L6.5 7.5 M16 15 L25.5 7.5 M16 15 V25" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" opacity="0.7" />
            <circle cx="16" cy="15" r="1.6" fill="white" />
          </svg>
        </div>
      </div>
      <canvas ref={canvasRef} className={cn("absolute inset-0 h-full w-full transition-opacity duration-700", ready ? "opacity-100" : "opacity-0")} />
    </div>
  );
}

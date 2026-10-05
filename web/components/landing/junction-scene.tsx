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
        <div className="relative aspect-square w-[46%] max-w-[260px]">
          <div className="absolute inset-0 rounded-full border border-mint/50 bg-[radial-gradient(circle,color-mix(in_oklab,var(--mint)_45%,transparent),transparent_70%)]" />
          <div className="absolute inset-[18%] rounded-full border border-mint/60" />
          <div className="absolute inset-[36%] rounded-full border border-mint/70 bg-mint/20" />
          <div className="absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_24px_var(--mint)]" />
        </div>
      </div>
      <canvas ref={canvasRef} className={cn("absolute inset-0 h-full w-full transition-opacity duration-700", ready ? "opacity-100" : "opacity-0")} />
    </div>
  );
}

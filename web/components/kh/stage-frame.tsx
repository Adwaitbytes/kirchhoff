"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePrefs } from "@/lib/prefs";

const W = 1920;
const H = 1080;

/**
 * Stage mode (`?stage=1`) locks the layout to 1920x1080 (PRD section 12). On a smaller window
 * the frame scales down to fit so a rehearsal on a laptop shows exactly what the recording shows.
 */
export function StageFrame({ children }: { children: ReactNode }) {
  const { stage } = usePrefs();
  const [scale, setScale] = useState(1);

  useEffect(() => {
    if (!stage) return;
    const fit = () => setScale(Math.min(1, window.innerWidth / W, window.innerHeight / H));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [stage]);

  if (!stage) return <>{children}</>;
  return (
    <div className="fixed inset-0 overflow-hidden bg-canvas">
      <div data-stage-frame="" style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: "top left" }} className="relative overflow-hidden">
        {children}
      </div>
    </div>
  );
}

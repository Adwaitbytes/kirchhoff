import type { CSSProperties, ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Scroll reveal in pure CSS: a scroll-driven animation (animation-timeline: view()) that only
 * runs where supported and where motion is allowed. Content is visible by default: without JS,
 * without support, under reduced motion, before it enters the viewport and in full-page captures.
 */
export function Reveal({ children, delay = 0, className, as: Tag = "div" }: { children: ReactNode; delay?: number; className?: string; as?: ElementType }) {
  const style = { "--reveal-offset": `${Math.min(delay, 240) / 12}%` } as CSSProperties;
  return (
    <Tag className={cn("reveal", className)} style={style}>
      {children}
    </Tag>
  );
}

/** First-paint entrance for above-the-fold content: pure CSS, plays before hydration. */
export function Enter({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <div className={cn("motion-safe:animate-[hero-in_800ms_cubic-bezier(0.22,1,0.36,1)_both]", className)} style={{ animationDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

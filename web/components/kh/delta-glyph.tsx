import { cn } from "@/lib/utils";

/**
 * Δ drawn on the same pixel grid as Geist Pixel, which has no U+0394 glyph of its own (the
 * fallback face would otherwise render a thin outlined triangle on a different baseline).
 */
export function DeltaGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 8 8" className={cn("inline-block h-[0.72em] w-[0.72em]", className)} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="miter">
      <path d="M4 1 L7.2 7.2 L0.8 7.2 Z" />
    </svg>
  );
}

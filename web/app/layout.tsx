import type { Metadata, Viewport } from "next";
import { DM_Mono, Inter } from "next/font/google";
import localFont from "next/font/local";
import { PREFS_BOOT_SCRIPT } from "@/lib/prefs";
import { Providers } from "@/app/providers";
import "./globals.css";

// The reference type system: Inter (variable, so the 450 body weight is real), DM Mono for every
// number and label, Geist Pixel for display. Geist Pixel is not in next/font/google's catalog yet,
// so its Google Fonts woff2 files are self-hosted. All three are preloaded with metric-matched fallbacks.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap", axes: ["opsz"], preload: true });
const dmMono = DM_Mono({ subsets: ["latin"], weight: ["400", "500"], style: ["normal", "italic"], variable: "--font-dm-mono", display: "swap", preload: true });
const geistPixel = localFont({
  src: [
    { path: "./fonts/GeistPixel-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/GeistPixel-latin-ext.woff2", weight: "400", style: "normal" },
  ],
  variable: "--font-geist-pixel",
  display: "swap",
  preload: true,
  adjustFontFallback: "Arial",
  fallback: ["ui-monospace", "monospace"],
});

export const metadata: Metadata = {
  title: { default: "KIRCHHOFF", template: "%s · KIRCHHOFF" },
  description: "A Cross-Chain Verifier for CCIP 2.0 that refuses to sign when a token's money stops adding up across chains.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0d10" },
    { media: "(prefers-color-scheme: light)", color: "#fafaf9" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${inter.variable} ${dmMono.variable} ${geistPixel.variable}`} suppressHydrationWarning>
      <body className="grain">
        {/* Runs before first paint so neither the theme nor stage mode flashes. */}
        <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: PREFS_BOOT_SCRIPT }} />
        <a href="#main" className="sr-only z-[100] rounded-md bg-fg px-3 py-2 text-canvas focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

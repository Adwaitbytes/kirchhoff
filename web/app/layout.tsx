import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { PREFS_BOOT_SCRIPT } from "@/lib/prefs";
import { Providers } from "@/app/providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap", axes: ["opsz"] });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

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
    <html lang="en" data-theme="dark" className={`${inter.variable} ${jetbrains.variable}`} suppressHydrationWarning>
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

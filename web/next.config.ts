import type { NextConfig } from "next";

const dataSource = process.env.NEXT_PUBLIC_DATA_SOURCE ?? "api";

// Fixture data is a development aid. A production deploy must never present it as real data.
if (dataSource === "fixtures" && process.env.VERCEL_ENV === "production") {
  throw new Error("NEXT_PUBLIC_DATA_SOURCE=fixtures is not allowed on a production deploy.");
}
// A deployed site must point at the hosted API, never at a developer's localhost.
if (dataSource === "api" && process.env.VERCEL === "1") {
  const api = process.env.NEXT_PUBLIC_API_URL ?? "";
  if (!/^https:\/\//.test(api) || /localhost|127\.0\.0\.1/.test(api)) {
    throw new Error(`NEXT_PUBLIC_API_URL must be the hosted https API base (with /v1) on Vercel, got "${api}".`);
  }
}
if (dataSource !== "fixtures" && dataSource !== "api") {
  throw new Error(`NEXT_PUBLIC_DATA_SOURCE must be "api" or "fixtures", got "${dataSource}".`);
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Lets fixture builds for Playwright live beside the real build without clobbering it.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  devIndicators: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
};

export default nextConfig;

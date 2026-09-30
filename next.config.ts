import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ─── Ariadne's Thread [AT-0001] ─────────────────────
  // What: Build a standalone Node server for the container image
  // Why:  Code Market runs this app as its own Cloudflare Container
  // Date: 2026-09-30
  // Related: cloudflare/worker.ts:CodeMarketContainer, Dockerfile
  // ─────────────────────────────────────────────────────
  output: "standalone",
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'www.google.com',
      },
    ],
  },
};

export default nextConfig;

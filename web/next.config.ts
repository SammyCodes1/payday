import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  agentRules: false, // do not let `next dev` write AGENTS.md / CLAUDE.md into the repo
  // The bundle check builds into a separate directory with canary secrets.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  reactStrictMode: true,
  // Heavy server-only SDKs stay as runtime node_modules, never bundled for the browser.
  serverExternalPackages: ["@circle-fin/developer-controlled-wallets"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

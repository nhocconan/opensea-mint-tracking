import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  reactStrictMode: true,
  poweredByHeader: false,
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  transpilePackages: [
    "@hoodmint/auth",
    "@hoodmint/config",
    "@hoodmint/core",
    "@hoodmint/db",
    "@hoodmint/notifications",
    "@hoodmint/observability",
    "@hoodmint/providers",
    "@hoodmint/queues",
    "@hoodmint/secrets",
    "@hoodmint/ui",
  ],
  serverExternalPackages: ["pino", "ioredis", "bullmq"],
  experimental: {
    serverActions: {
      bodySizeLimit: "1mb",
    },
  },
};

export default nextConfig;

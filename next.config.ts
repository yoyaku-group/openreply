import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactCompiler: true,
  reactStrictMode: true,
  // The copywriter prompt seed is read from disk at runtime (lazy v1 seed per
  // workspace); standalone output would drop it without an explicit include.
  outputFileTracingIncludes: {
    "/**": ["./lib/assistant/prompts/**"],
  },
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Accel-Buffering",
            value: "no",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

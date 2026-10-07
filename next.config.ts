import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    const frameAncestors = process.env.EMBED_FRAME_ANCESTORS?.trim() || "'self'";
    return [
      {
        source: "/widget/:path*",
        headers: [
          { key: "Content-Security-Policy", value: `frame-ancestors ${frameAncestors}` },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;

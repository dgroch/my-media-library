import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Asset previews are served from a CDN. We render them with plain <img>
  // tags (no next/image optimization) so any CDN host works without extra
  // configuration. Nothing to allowlist here.
};

export default nextConfig;

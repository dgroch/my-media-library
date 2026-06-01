import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Asset previews are served from a CDN and rendered with plain <img> tags, so
  // there is nothing to allowlist for image optimization.
  //
  // Ensure the prebuilt search index files are traced into the server output
  // (belt-and-suspenders for standalone builds; with `next start` they are
  // already present in the project directory).
  outputFileTracingIncludes: {
    "/api/search": ["./src/data/asset-index.json", "./src/data/asset-index.vec.bin"],
  },
};

export default nextConfig;

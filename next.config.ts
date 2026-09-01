import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Pin the workspace root to this folder — the parent directory has its own
  // lockfile and Next.js otherwise infers the wrong root when run via --prefix.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;

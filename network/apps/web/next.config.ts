import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@lattice/config", "@lattice/protocol", "@lattice/monitor", "@lattice/bridge"],
  poweredByHeader: false,
};

export default nextConfig;

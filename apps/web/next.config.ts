import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @irp/shared is consumed as TypeScript source from the monorepo.
  transpilePackages: ["@irp/shared"],
};

export default nextConfig;

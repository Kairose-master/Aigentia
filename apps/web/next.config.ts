import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@aigentia/protocol", "@aigentia/shared"],
  reactStrictMode: true,
};

export default nextConfig;

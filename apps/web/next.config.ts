import type { NextConfig } from "next";

/**
 * Fail closed on Vercel: a hosted build must either serve the recorded snapshot or point at a
 * public API. Otherwise the dashboard would claim to be live while talking to localhost.
 */
if (process.env.VERCEL === "1") {
  const mode = process.env.NEXT_PUBLIC_DATA_MODE;
  const api = process.env.NEXT_PUBLIC_API_URL ?? "";
  const publicApi = /^https:\/\//.test(api) && !/localhost|127\.0\.0\.1/.test(api);
  if (mode !== "snapshot" && !publicApi) {
    throw new Error(
      "Vercel build refused: set NEXT_PUBLIC_DATA_MODE=snapshot, or NEXT_PUBLIC_API_URL to a public https API.",
    );
  }
}

const nextConfig: NextConfig = {
  transpilePackages: ["@aigentia/protocol", "@aigentia/shared"],
  reactStrictMode: true,
};

export default nextConfig;

/** @type {import('next').NextConfig} */

// The browser-facing API base.  When empty, the client uses same-origin
// relative URLs which this Next.js server proxies to the backend below –
// the recommended production topology behind a reverse proxy / ingress.
const backendOrigin =
  process.env.BACKEND_ORIGIN || process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    // Only enable the same-origin proxy when no explicit public API URL is
    // baked in at build time (NEXT_PUBLIC_API_URL is inlined at build).
    if (process.env.NEXT_PUBLIC_API_URL) return [];
    return [
      { source: "/api/v1/:path*", destination: `${backendOrigin}/api/v1/:path*` },
      { source: "/ws/:path*", destination: `${backendOrigin}/ws/:path*` },
      { source: "/healthz", destination: `${backendOrigin}/healthz` },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;

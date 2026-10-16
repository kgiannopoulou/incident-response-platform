import type { NextConfig } from "next";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const isDev = process.env.NODE_ENV !== "production";

// Security headers for every page (Phase 24). The Content-Security-Policy
// only lets the app talk to itself and to the API: an injected script
// couldn't send data anywhere else, load code from elsewhere, or frame the
// app for clickjacking. Next.js' hydration uses inline scripts (and the dev
// server eval), hence 'unsafe-inline' / dev-only 'unsafe-eval'; React escapes
// rendered text, which is the primary XSS defence — the app never uses
// dangerouslySetInnerHTML.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${new URL(apiUrl).origin}${isDev ? " ws:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // @irp/shared is consumed as TypeScript source from the monorepo.
  transpilePackages: ["@irp/shared"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;

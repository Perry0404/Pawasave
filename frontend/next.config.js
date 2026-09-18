/** @type {import('next').NextConfig} */
const nextConfig = {
  // FIND-INFRA-01: don't advertise the framework/version.
  poweredByHeader: false,
  reactStrictMode: true,
  compress: true,
  // Self-hosted (Docker/Coolify) build: emit a standalone server bundle
  // (.next/standalone/server.js) so the runtime image needs no node_modules.
  // Vercel ignores this; it only changes what `next build` writes to disk.
  output: 'standalone',
  experimental: {
    // HyperFX (Hyperbridge Intent Gateway) deps are OPTIONAL and dark: lib/hyperfx.ts
    // dynamically imports them only when HYPERFX_ENABLED. Marking them external means the
    // build does NOT try to bundle/resolve them, so the app compiles and deploys fine
    // BEFORE `npm i @hyperbridge/sdk viem` — they're required at runtime only when enabled.
    serverComponentsExternalPackages: ['@hyperbridge/sdk', 'viem'],
  },
  // Serve the static platform documentation at a clean /docs path.
  async rewrites() {
    return [
      { source: '/docs', destination: '/docs.html' },
      { source: '/deck', destination: '/deck.html' },
      { source: '/proposal', destination: '/proposal.html' },
      { source: '/explainer', destination: '/explainer.html' },
      { source: '/tour', destination: '/tour.html' },
    ];
  },
  // Security headers applied at the framework layer for ALL routes (FIND-INFRA-02,
  // FIND-API-05). Previously set per-request in middleware, which forced a middleware
  // invocation on every page/asset (a billing hot spot). Moving them here applies them
  // for free and lets middleware run on /api/* only.
  async headers() {
    const securityHeaders = [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-XSS-Protection', value: '1; mode=block' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
      {
        key: 'Content-Security-Policy',
        value: [
          "default-src 'self'",
          "base-uri 'self'",
          "object-src 'none'",
          "frame-ancestors 'none'",
          "form-action 'self'",
          "img-src 'self' data: https:",
          "font-src 'self' data:",
          "style-src 'self' 'unsafe-inline'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
          "connect-src 'self' https: wss:",
        ].join('; '),
      },
    ];
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

module.exports = nextConfig;
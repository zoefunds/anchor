/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdf-parse (lib/pdf-extract.ts) fails inside Next's own bundling of
  // API routes - "Object.defineProperty called on non-object" - but
  // works fine standalone (plain node, tsx). Excluding it from Next's
  // bundler and letting it load via Node's normal require/import at
  // runtime instead fixes it; confirmed by reproducing the failure only
  // inside a route handler, never outside one.
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse"],
  },
};

module.exports = nextConfig;

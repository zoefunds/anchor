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
  // @reown/appkit-utils' ethers BaseProvider (pulled in by
  // @reown/appkit-adapter-ethers for the deposit page's real wallet
  // connection) reaches into @base-org/account -> @coinbase/cdp-sdk's
  // Coinbase Smart Wallet x402-payment support, which imports several
  // @x402/* sub-packages that were never published. This app never
  // configures or triggers the Coinbase Smart Wallet path, so that code
  // is dead at runtime — aliasing it to false tells webpack to stub the
  // import as empty rather than fail the build. Confirmed by direct
  // reproduction: the same broken chain is reached via the ethers
  // adapter, not just the (now-removed) wagmi adapter.
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/evm/upto/client": false,
      "@x402/evm/exact/client": false,
      "@x402/core/client": false,
      "@x402/svm/exact/client": false,
      "@x402/evm": false,
      "@x402/core": false,
      "@x402/svm": false,
    };
    return config;
  },
};

module.exports = nextConfig;

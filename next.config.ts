import type { NextConfig } from 'next';

// The container image sets NEXT_OUTPUT=standalone to build a self-contained server (`node server.js`).
// Local `npm run build && npm start` is unchanged, because `next start` does not work with standalone output.
const standalone = process.env.NEXT_OUTPUT === 'standalone';

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  ...(standalone && {
    output: 'standalone' as const,
    // Several server modules read files by a computed path, which makes the tracer include the whole project.
    // Keep keys, databases and collector data out of the traced output; the image copies the published city data explicitly.
    outputFileTracingExcludes: {
      '/**': ['.testnet-secrets/**', '.data/**', '.env*', 'stadtstack-data/**', 'contracts/**', 'programs/**', 'target/**', 'docs/**', '.git/**'],
    },
  }),
};

export default config;

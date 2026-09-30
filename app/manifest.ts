import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Ledger of Life',
    short_name: 'Ledger',
    start_url: '/',
    display: 'standalone',
    theme_color: '#28583e',
    background_color: '#f6f6f1',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  };
}

import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Ledger of Life',
    short_name: 'Ledger',
    start_url: '/',
    display: 'standalone',
    theme_color: '#15263b',
    background_color: '#f5f6f2',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  };
}

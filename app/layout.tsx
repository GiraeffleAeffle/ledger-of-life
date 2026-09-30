import type { Metadata } from 'next';
import './globals.css';

function metadataBaseFromOrigin(): URL | undefined {
  if (!process.env.APP_ORIGIN) return undefined;
  try {
    return new URL(process.env.APP_ORIGIN);
  } catch {
    return undefined;
  }
}

const metadataBase = metadataBaseFromOrigin();

export const metadata: Metadata = {
  ...(metadataBase ? { metadataBase } : {}),
  title: 'Ledger of Life · Everything that is yours, in one place',
  description:
    'Your verified identity, your home and deposit, what you own and earn, and what is changing in your city. A test-network prototype.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}

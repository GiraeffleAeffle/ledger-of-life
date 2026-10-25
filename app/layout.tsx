import type { Metadata } from 'next';
import { THREAD } from '../src/data/path.ts';
import { LegalFooter } from '../src/components/legal-footer.tsx';
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
  title: `Ledger of Life · ${THREAD}`,
  description:
    'Rent a flat with a deposit held in a test-network escrow, see what you own, and follow what your city decides. No real money moves.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <LegalFooter />
      </body>
    </html>
  );
}

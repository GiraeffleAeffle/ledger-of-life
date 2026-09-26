import type { Metadata } from 'next';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';
import './globals.css';
import { WalletProvider } from '@/wallets';

export const metadata: Metadata = {
  title: 'Ledger of Life · Everything that is yours, in one place',
  description:
    'Your verified identity, your home and deposit, what you own and earn, and what is changing in your city. A test-network prototype.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}

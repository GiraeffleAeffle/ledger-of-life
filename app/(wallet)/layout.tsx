import { WalletProvider } from '@/wallets';

// The wallet SDK contacts its providers as soon as it mounts, so it lives only in this route group.
// Public pages (such as /welcome) sit outside it and load nothing from a third party.
export default function WalletLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <WalletProvider>{children}</WalletProvider>;
}

import type { Metadata } from 'next';
import { ShareDepositReplay } from '@/components/replay-share-deposit';
import '@/components/replay-share-deposit.css';

export const metadata: Metadata = {
  title: 'Recorded share-deposit tenancy · Ledger of Life',
  description: 'Follow the recorded 1 October test-network tenancy through seven Home steps, with transaction evidence. No account needed; test tokens have no value.',
};

export default function ReplayPage() {
  return <ShareDepositReplay />;
}

import { notFound } from 'next/navigation';
import { DesignLab } from '@/components/design-lab';

export const metadata = { title: 'Design lab · Ledger of Life' };

/** Fixture screens for choosing how things should look. Not part of the product: production builds return 404. */
export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <DesignLab />;
}

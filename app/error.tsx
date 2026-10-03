'use client';
import Link from 'next/link';

export default function Error({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="route-fallback">
      <h1>This part of Ledger of Life could not be shown.</h1>
      <p>The rest of the app still works.</p>
      <button className="button primary" onClick={retry}>Try again</button>
      <Link href="/">Go to Home</Link>
    </main>
  );
}

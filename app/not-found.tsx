import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="route-fallback">
      <h1>That page was not found.</h1>
      <p>Ledger of Life is still available.</p>
      <Link className="button primary" href="/">Go to Home</Link>
    </main>
  );
}

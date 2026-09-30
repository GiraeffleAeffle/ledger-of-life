'use client';

/** Replaces the root layout when it fails, so it brings its own document and uses a full reload rather than client routing. */
export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'sans-serif', background: '#f6f6f1', color: '#20372b', padding: '2rem' }}>
        <style>{'button:focus-visible,a:focus-visible{outline:3px solid #28583e;outline-offset:4px}'}</style>
        <main>
          <h1>Ledger of Life could not be shown.</h1>
          <p>You can try again or return to Today.</p>
          <button style={{ padding: '12px', border: '2px solid #28583e', borderRadius: '8px', cursor: 'pointer' }} onClick={retry}>Try again</button>{' '}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- the root layout failed, so a full page load is the point */}
          <a href="/">Go to Today</a>
        </main>
      </body>
    </html>
  );
}

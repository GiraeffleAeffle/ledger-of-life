'use client';

/** Replaces the root layout when it fails, so it brings its own document and uses a full reload rather than client routing. */
export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'sans-serif', background: '#f5f6f2', color: '#15263b', padding: '2rem' }}>
        <style>{'button:focus-visible,a:focus-visible{outline:3px solid #2d5fb3;outline-offset:2px}a{color:#15263b}button:hover{background:#33455a}'}</style>
        <main>
          <h1>Ledger of Life could not be shown.</h1>
          <p>You can try again or return to Today.</p>
          <button style={{ minHeight: '44px', padding: '12px 20px', background: '#15263b', color: '#fff', border: 0, borderRadius: '999px', cursor: 'pointer' }} onClick={retry}>Try again</button>{' '}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- the root layout failed, so a full page load is the point */}
          <a href="/">Go to Today</a>
        </main>
      </body>
    </html>
  );
}

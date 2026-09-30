import { ImageResponse } from 'next/og';
import { notFound } from 'next/navigation';
import { arrivalGuideFor } from '@/data/arrival';

export const alt = 'A community welcome guide · not an official city service · Ledger of Life';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function WelcomeOpenGraphImage({ params }: { params: Promise<{ city: string }> }) {
  const guide = arrivalGuideFor((await params).city);
  if (!guide) notFound();

  return new ImageResponse(
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: 72, background: '#f6f6f1', color: '#20372b', justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <svg width="88" height="88" viewBox="0 0 44 44">
          <g transform="rotate(-8 22 22) translate(4.5 4.5)" fill="#28583e">
            <path d="M0 7Q0 0 7 0H15Q16 0 16 1V9Q16 16 9 16H1Q0 16 0 15Z" />
            <path transform="translate(19 0)" d="M0 7Q0 0 7 0H15Q16 0 16 1V9Q16 16 9 16H1Q0 16 0 15Z" />
            <path transform="translate(0 19)" d="M0 7Q0 0 7 0H15Q16 0 16 1V9Q16 16 9 16H1Q0 16 0 15Z" />
            <path transform="translate(19 19)" fill="#bed1ad" d="M0 7Q0 0 7 0H15Q16 0 16 1V9Q16 16 9 16H1Q0 16 0 15Z" />
          </g>
        </svg>
        <div style={{ fontSize: 36, fontWeight: 700 }}>Ledger of Life</div>
      </div>
      <div style={{ display: 'flex', fontSize: 88, fontWeight: 700, lineHeight: 1.1, letterSpacing: -2 }}>Welcome to {guide.cityName}</div>
      <div style={{ display: 'flex', maxWidth: 960, fontSize: 32, lineHeight: 1.4, color: '#59695a' }}>A community guide for your first months · not an official city service</div>
    </div>,
    size,
  );
}

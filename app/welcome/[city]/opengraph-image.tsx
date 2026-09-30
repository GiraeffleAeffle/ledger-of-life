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
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: 72, background: '#f5f6f2', color: '#15263b', justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <svg width="88" height="96.8" viewBox="0 0 40 44">
          <path d="M5 31 20 39 35 31 20 23Z" fill="#76a753" />
          <path d="M5 24 20 32 35 24 20 16Z" fill="#39a7b9" />
          <path d="M5 17 20 25 35 17 20 9Z" fill="#e9ac43" />
          <path d="M5 10 20 18 35 10 20 2Z" fill="#e97661" />
          <path d="M5 10V31L20 39" fill="none" stroke="#15263b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M14 10 22 14" fill="none" stroke="#15263b" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <div style={{ fontSize: 36, fontWeight: 700 }}>Ledger of Life</div>
      </div>
      <div style={{ display: 'flex', fontSize: 88, fontWeight: 700, lineHeight: 1.1, letterSpacing: -2 }}>Welcome to {guide.cityName}</div>
      <div style={{ display: 'flex', maxWidth: 960, fontSize: 32, lineHeight: 1.4, color: '#56677a' }}>A community guide for your first months · not an official city service</div>
    </div>,
    size,
  );
}

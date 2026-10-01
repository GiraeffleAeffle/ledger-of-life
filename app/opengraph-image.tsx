import { ImageResponse } from 'next/og';
import { THREAD } from '../src/data/path.ts';

export const alt = `Ledger of Life · ${THREAD} · Test networks · no real money`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: 72, background: '#f5f6f2', color: '#15263b', justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
        <svg width="104" height="114.4" viewBox="0 0 40 44">
          <path d="M5 31 20 39 35 31 20 23Z" fill="#76a753" />
          <path d="M5 24 20 32 35 24 20 16Z" fill="#39a7b9" />
          <path d="M5 17 20 25 35 17 20 9Z" fill="#e9ac43" />
          <path d="M5 10 20 18 35 10 20 2Z" fill="#e97661" />
          <path d="M5 10V31L20 39" fill="none" stroke="#15263b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M14 10 22 14" fill="none" stroke="#15263b" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <div style={{ fontSize: 56, fontWeight: 700 }}>Ledger of Life</div>
      </div>
      <div style={{ display: 'flex', maxWidth: 1000, fontSize: 60, fontWeight: 700, lineHeight: 1.12, letterSpacing: -1.5 }}>{THREAD}</div>
      <div style={{ display: 'flex', fontSize: 26, color: '#56677a' }}>Test networks · no real money</div>
    </div>,
    size,
  );
}

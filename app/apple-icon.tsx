import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', background: '#f5f6f2' }}>
      <svg width="132" height="145.2" viewBox="0 0 40 44">
        <path d="M5 31 20 39 35 31 20 23Z" fill="#76a753" />
        <path d="M5 24 20 32 35 24 20 16Z" fill="#39a7b9" />
        <path d="M5 17 20 25 35 17 20 9Z" fill="#e9ac43" />
        <path d="M5 10 20 18 35 10 20 2Z" fill="#e97661" />
        <path d="M5 10V31L20 39" fill="none" stroke="#15263b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 10 22 14" fill="none" stroke="#15263b" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </div>,
    size,
  );
}

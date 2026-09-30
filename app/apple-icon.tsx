import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', background: '#f6f6f1' }}>
      <svg width="144" height="144" viewBox="0 0 44 44">
        <g transform="rotate(-8 22 22) translate(4.5 4.5)" fill="#28583e">
          <path d="M0 7Q0 0 7 0H15Q16 0 16 1V9Q16 16 9 16H1Q0 16 0 15Z" />
          <path transform="translate(19 0)" d="M0 7Q0 0 7 0H15Q16 0 16 1V9Q16 16 9 16H1Q0 16 0 15Z" />
          <path transform="translate(0 19)" d="M0 7Q0 0 7 0H15Q16 0 16 1V9Q16 16 9 16H1Q0 16 0 15Z" />
          <path transform="translate(19 19)" fill="#bed1ad" d="M0 7Q0 0 7 0H15Q16 0 16 1V9Q16 16 9 16H1Q0 16 0 15Z" />
        </g>
      </svg>
    </div>,
    size,
  );
}

import { ImageResponse } from "next/og";

// Apple touch icon — rasterized from the brand mark at build time. No text,
// so satori needs no font. Matches app/icon.svg.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const MARK = `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="64" height="64" rx="14" fill="#070908"/>
  <g stroke="#2c352e" stroke-width="1.5">
    <circle cx="32" cy="32" r="21"/><circle cx="32" cy="32" r="13.5"/><circle cx="32" cy="32" r="6"/>
  </g>
  <g stroke="#1e2420" stroke-width="1.5"><path d="M32 9 V55"/><path d="M9 32 H55"/></g>
  <path d="M32 32 L32 11 A21 21 0 0 1 50.85 22.4 Z" fill="url(#s)"/>
  <path d="M32 32 L32 11" stroke="#b8ff2e" stroke-opacity="0.85" stroke-width="1.5"/>
  <path d="M45 18.6 l3.9 2.25 v4.5 l-3.9 2.25 -3.9-2.25 v-4.5 z" fill="#b8ff2e"/>
  <circle cx="32" cy="32" r="3.2" fill="#b8ff2e"/>
  <defs><linearGradient id="s" x1="32" y1="32" x2="51" y2="15" gradientUnits="userSpaceOnUse">
    <stop stop-color="#b8ff2e" stop-opacity="0.55"/><stop offset="1" stop-color="#b8ff2e" stop-opacity="0"/>
  </linearGradient></defs>
</svg>`;

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#070908",
      }}
    >
      {/* biome-ignore lint/performance/noImgElement: satori only renders <img>, not next/image */}
      <img
        width={150}
        height={150}
        alt="HoodMint Radar"
        src={`data:image/svg+xml;utf8,${encodeURIComponent(MARK)}`}
      />
    </div>,
    size,
  );
}

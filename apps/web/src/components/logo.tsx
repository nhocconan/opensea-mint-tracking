/**
 * HoodMint Radar brand mark — a radar sweep with a hexagonal mint blip in
 * the swept quadrant ("a radar, not a casino: acid on obsidian", DESIGN.md).
 * Self-contained SVG (fixed brand colors, badge reads on both themes).
 * The same artwork is the favicon (app/icon.svg) and apple/OG icons.
 */

interface LogoProps {
  readonly className?: string;
  readonly showWordmark?: boolean;
}

export function LogoMark({ className = "size-6" }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="HoodMint Radar"
    >
      <rect width="64" height="64" rx="14" fill="#070908" />
      <rect
        x="0.75"
        y="0.75"
        width="62.5"
        height="62.5"
        rx="13.25"
        stroke="#b8ff2e"
        strokeOpacity="0.28"
        strokeWidth="1.5"
      />
      <g stroke="#2c352e" strokeWidth="1.5">
        <circle cx="32" cy="32" r="21" />
        <circle cx="32" cy="32" r="13.5" />
        <circle cx="32" cy="32" r="6" />
      </g>
      <g stroke="#1e2420" strokeWidth="1.5">
        <path d="M32 9 V55" />
        <path d="M9 32 H55" />
      </g>
      <path d="M32 32 L32 11 A21 21 0 0 1 50.85 22.4 Z" fill="url(#hm-sweep)" />
      <path d="M32 32 L32 11" stroke="#b8ff2e" strokeOpacity="0.85" strokeWidth="1.5" />
      <path d="M45 18.6 l3.9 2.25 v4.5 l-3.9 2.25 -3.9-2.25 v-4.5 z" fill="#b8ff2e" />
      <circle cx="32" cy="32" r="3.2" fill="#b8ff2e" />
      <defs>
        <linearGradient
          id="hm-sweep"
          x1="32"
          y1="32"
          x2="51"
          y2="15"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#b8ff2e" stopOpacity="0.55" />
          <stop offset="1" stopColor="#b8ff2e" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** Mark + wordmark lockup for the nav rail and mobile header. */
export function Logo({ className = "size-6", showWordmark = true }: LogoProps) {
  return (
    <span className="flex items-center gap-2">
      <LogoMark className={className} />
      {showWordmark ? (
        <span className="font-display text-sm font-semibold tracking-wide">
          HOOD<span className="text-acid">MINT</span>
        </span>
      ) : null}
    </span>
  );
}

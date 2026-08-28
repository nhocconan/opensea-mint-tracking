import type { MetadataRoute } from "next";

// PWA manifest — the app already ships a service worker (sw.js) for Web Push
// alerts, so an installable manifest completes the story. Obsidian theme,
// SVG mark for any + maskable (the mark has its own safe padding).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "HoodMint Radar",
    short_name: "HoodMint",
    description:
      "NFT drop discovery, allowlist eligibility, and mint execution for Robinhood Chain",
    start_url: "/",
    display: "standalone",
    background_color: "#070908",
    theme_color: "#070908",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any", purpose: "any" },
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any", purpose: "maskable" },
    ],
  };
}

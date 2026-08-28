import { getSetting } from "@hoodmint/db";
import { DemoBanner, parseThemePreference, resolveTheme, THEME_COOKIE } from "@hoodmint/ui";
import type { Metadata, Viewport } from "next";
import { Geist_Mono, Space_Grotesk } from "next/font/google";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell.tsx";
import { container } from "@/lib/container.ts";
import { getSessionUser } from "@/lib/session.ts";
import "./globals.css";

const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "HoodMint Radar", template: "%s · HoodMint Radar" },
  description: "NFT drop discovery and allowlist eligibility radar for Robinhood Chain",
  applicationName: "HoodMint Radar",
  appleWebApp: { capable: true, title: "HoodMint", statusBarStyle: "black-translucent" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#070908",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let demoMode = false;
  try {
    demoMode =
      (await getSetting<boolean>(container().db, "demo_mode")) === true ||
      container().config.DEMO_MODE;
  } catch {
    // Database not migrated yet (first boot) — plain shell, no banner.
  }

  const cookieStore = await cookies();
  const theme = resolveTheme(parseThemePreference(cookieStore.get(THEME_COOKIE)?.value));

  let signedIn = false;
  try {
    signedIn = (await getSessionUser()) !== null;
  } catch {
    // Session lookup best-effort; a signed-out shell is the safe default.
  }

  return (
    <html
      lang="en"
      data-theme={theme}
      style={{ colorScheme: theme }}
      className={`${display.variable} ${mono.variable}`}
    >
      <body className="min-h-dvh bg-base text-ink antialiased">
        {demoMode ? <DemoBanner /> : null}
        <AppShell theme={theme} signedIn={signedIn}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}

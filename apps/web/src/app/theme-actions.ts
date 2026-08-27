"use server";

import { isTheme, THEME_COOKIE } from "@hoodmint/ui";
import { cookies } from "next/headers";

/** Persist an explicit dark/light choice. Rejects anything else. */
export async function persistThemeAction(raw: string): Promise<void> {
  if (!isTheme(raw)) {
    return;
  }
  const store = await cookies();
  store.set(THEME_COOKIE, raw, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.APP_ENV === "production",
  });
}

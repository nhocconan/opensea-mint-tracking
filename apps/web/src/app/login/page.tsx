import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session.ts";
import { LoginForm } from "./login-form.tsx";

export const metadata: Metadata = { title: "Sign in" };

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user !== null) {
    redirect("/");
  }
  return (
    <section className="mx-auto max-w-sm px-4 py-10">
      <h1 className="font-display text-lg font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-xs text-ink-muted">
        Operator and admin features (watchlists, scans, credentials) require an account.
      </p>
      <LoginForm />
    </section>
  );
}

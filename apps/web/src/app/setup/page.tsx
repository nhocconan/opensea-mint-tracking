import { hasAnyUser } from "@hoodmint/auth";
import type { Metadata } from "next";
import { Logo } from "@/components/logo.tsx";
import { container } from "@/lib/container.ts";
import { SetupForm } from "./setup-form.tsx";

export const metadata: Metadata = { title: "Setup" };

export const dynamic = "force-dynamic";

/** First-run bootstrap (PRD §16): one-time token → first admin. */
export default async function SetupPage() {
  const { db } = container();
  let initialized = false;
  try {
    initialized = await hasAnyUser(db);
  } catch {
    // DB not migrated yet; the form will surface actionable errors.
  }

  return (
    <section className="mx-auto max-w-md px-4 py-10">
      <Logo className="mb-6 size-9" />
      <h1 className="font-display text-lg font-semibold tracking-tight">HoodMint Radar setup</h1>
      <p className="mt-1 text-xs text-ink-muted">
        Create the first administrator with a one-time bootstrap token. Generate one with{" "}
        <code className="rounded-xs bg-base-overlay px-1 font-mono text-acid">make token</code> if
        you don&apos;t have it.
      </p>
      {initialized ? (
        <p
          role="status"
          className="mt-6 rounded-sm border border-amber/40 bg-amber/10 px-3 py-2 text-sm text-amber"
        >
          Setup already completed. Sign in at{" "}
          <a
            href="/login"
            className="inline-flex min-h-6 items-center underline focus:outline-none focus:ring-2 focus:ring-acid/50"
          >
            /login
          </a>
          .
        </p>
      ) : (
        <SetupForm />
      )}
    </section>
  );
}

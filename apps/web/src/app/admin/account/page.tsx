import type { Metadata } from "next";
import { PasskeyRegistration } from "@/app/admin/execution/passkey-registration.tsx";
import { getSessionUser } from "@/lib/session.ts";

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

/** Admin → Account: per-user security settings (passkey today; 2FA server-side). */
export default async function AdminAccountPage() {
  const user = await getSessionUser();

  return (
    <div className="space-y-3">
      <section className="rounded-md border border-line bg-base-raised p-4">
        <h1 className="font-display text-lg font-semibold tracking-tight">
          Account &amp; security
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Signed in as <span className="font-mono text-ink">{user?.email ?? "—"}</span>
          {user?.role !== undefined ? ` · ${user.role}` : ""}. Register a passkey below — it is
          required to arm a mint or import a signing key, and enables one-tap passkey sign-in.
        </p>
      </section>

      <PasskeyRegistration />

      <section className="rounded-md border border-line bg-base-raised p-4">
        <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Two-factor (TOTP)
        </h2>
        <p className="mt-1 text-xs text-ink-muted">
          TOTP two-factor is available on the server (Better Auth twoFactor). Passkey is the
          stronger factor and is what the arm/import step-up requires; enroll a passkey above first.
        </p>
      </section>
    </div>
  );
}

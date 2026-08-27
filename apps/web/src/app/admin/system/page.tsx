import { getSetting, listOutbox } from "@hoodmint/db";
import { container } from "@/lib/container.ts";
import { formatDateTimeUtc } from "@/lib/format.ts";
import { DemoModeToggle, ScanNowButton } from "./system-buttons.tsx";

export const dynamic = "force-dynamic";

/** Admin → System (PRD §7.5): scan now, demo mode, outbox, retention policy. */
export default async function AdminSystemPage() {
  const { db } = container();
  const [outbox, demoMode] = await Promise.all([
    listOutbox(db, 20).catch(() => []),
    getSetting<boolean>(db, "demo_mode").catch(() => false),
  ]);

  return (
    <div className="grid gap-3">
      <section className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-base-raised p-4">
        <ScanNowButton />
        <DemoModeToggle enabled={demoMode === true} />
      </section>

      <section className="rounded-md border border-line bg-base-raised p-4">
        <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Notification outbox (durable, retried independently)
        </h2>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[10px] text-ink-faint uppercase">
              <th className="py-1 font-normal">Type</th>
              <th className="py-1 font-normal">Status</th>
              <th className="py-1 font-normal">Attempts</th>
              <th className="py-1 font-normal">Next attempt</th>
              <th className="py-1 font-normal">Last error</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {outbox.map((row) => (
              <tr key={row.id}>
                <td className="py-1">{row.alertType}</td>
                <td
                  className={
                    row.status === "sent"
                      ? "text-acid"
                      : row.status === "dead"
                        ? "text-magenta"
                        : "text-amber"
                  }
                >
                  {row.status}
                </td>
                <td className="py-1">{row.attempts}</td>
                <td className="py-1 text-ink-faint">{formatDateTimeUtc(row.nextAttemptAt)}</td>
                <td className="py-1 text-magenta/80">{row.lastErrorCode ?? "—"}</td>
              </tr>
            ))}
            {outbox.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-2 text-ink-faint">
                  Outbox empty.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="rounded-md border border-line bg-base-raised p-4 font-mono text-[11px] text-ink-muted">
        <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Retention defaults
        </h2>
        <ul className="space-y-0.5">
          <li>raw evidence — 30 days</li>
          <li>scan runs — 90 days</li>
          <li>mint events — 180 days</li>
          <li>aggregates &amp; audit logs — indefinite</li>
        </ul>
        <p className="mt-2">
          Backups: <code>make backup</code> / <code>make restore file=…</code> (PostgreSQL only;
          Valkey holds no durable state).
        </p>
      </section>
    </div>
  );
}

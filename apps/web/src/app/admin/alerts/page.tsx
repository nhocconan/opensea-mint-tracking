import { sql } from "drizzle-orm";
import { container } from "@/lib/container.ts";
import { formatDateTimeUtc } from "@/lib/format.ts";
import { ChannelForms, TestButton } from "./channel-forms.tsx";
import { ChannelRowActions } from "./channel-row-actions.tsx";

export const dynamic = "force-dynamic";

interface ChannelRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly last_success_at: Date | null;
  readonly last_error_code: string | null;
}

/** Admin → Alerts (PRD §7.5): channels, tests, dedupe policy visibility. */
export default async function AdminAlertsPage() {
  const { db, config } = container();
  const result = await db
    .execute(
      sql`select id, kind, name, enabled, last_success_at, last_error_code from alert_channels order by created_at desc`,
    )
    .catch(() => ({ rows: [] as unknown as ChannelRow[] }));
  // db.execute() on this postgres-js driver returns the row array
  // directly, no `.rows` wrapper (verified live 2026-08-22) — `.rows ??
  // []` always fell through to `[]`, so "Configured channels" silently
  // showed "No channels yet." even when channels existed.
  const channels = ((result as unknown as { rows?: ChannelRow[] }).rows ??
    (result as unknown as ChannelRow[])) as ChannelRow[];

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <ChannelForms vapidPublicKey={config.VAPID_PUBLIC_KEY ?? null} />

      <section className="rounded-md border border-line bg-base-raised p-4">
        <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Configured channels
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] text-ink-faint uppercase">
                <th scope="col" className="py-1 font-normal">
                  Kind
                </th>
                <th scope="col" className="py-1 font-normal">
                  Name
                </th>
                <th scope="col" className="py-1 font-normal">
                  Enabled
                </th>
                <th scope="col" className="py-1 font-normal">
                  Last success
                </th>
                <th scope="col" className="py-1 font-normal">
                  Last error
                </th>
                <th scope="col" className="py-1 font-normal">
                  Test
                </th>
                <th scope="col" className="py-1 font-normal">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {channels.map((c) => (
                <tr key={c.id} className={c.enabled ? "" : "opacity-60"}>
                  <td className="py-1">{c.kind}</td>
                  <td className="py-1">{c.name}</td>
                  <td className={c.enabled ? "py-1 text-acid" : "py-1 text-ink-faint"}>
                    {c.enabled ? "yes" : "no"}
                  </td>
                  <td className="py-1 text-ink-faint">{formatDateTimeUtc(c.last_success_at)}</td>
                  <td className="py-1 text-magenta/80">{c.last_error_code ?? "—"}</td>
                  <td className="py-1">
                    <TestButton channelId={c.id} />
                  </td>
                  <td className="py-1">
                    <ChannelRowActions id={c.id} name={c.name} kind={c.kind} enabled={c.enabled} />
                  </td>
                </tr>
              ))}
              {channels.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-2 text-ink-faint">
                    No channels yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-ink-faint">
          Alerts dedupe on deployment+wallet+project+stage+type+threshold and send through a durable
          outbox with independent retries. Stage-start windows:{" "}
          {config.ALERT_STAGE_WINDOWS_MINUTES.join(", ")} min.
        </p>
      </section>
    </div>
  );
}

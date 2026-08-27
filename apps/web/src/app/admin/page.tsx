import {
  listMintPlans,
  listProviders,
  listRpcEndpoints,
  pendingOutboxDepth,
  recentScanRuns,
} from "@hoodmint/db";
import { sql } from "drizzle-orm";
import { container } from "@/lib/container.ts";
import { formatDateTimeUtc } from "@/lib/format.ts";

export const dynamic = "force-dynamic";

interface OverviewCounts {
  readonly liveNow: number;
  readonly next: number;
  readonly watched: number;
  readonly channelsTotal: number;
  readonly channelsErrored: number;
}

/**
 * Command-center stat row (feature-backlog.md's "admin control panel is
 * full featured, rich" gap, addressed 2026-08-22): every number here
 * already exists on its own admin sub-page (Execution, Alerts, the feed
 * views) — this pulls the ones an operator actually wants at a glance
 * into one place instead of five separate page loads. Read-only
 * aggregation of existing tables; no new schema.
 */
async function overviewCounts(db: ReturnType<typeof container>["db"]): Promise<OverviewCounts> {
  const result = await db.execute(sql`
    select
      (select count(*)::int from projects where lifecycle_status = 'LIVE') as live_now,
      (select count(*)::int from projects where lifecycle_status = 'NEXT') as next_count,
      (select count(*)::int from watchlist_entries) as watched,
      (select count(*)::int from alert_channels) as channels_total,
      (select count(*)::int from alert_channels where last_error_code is not null) as channels_errored
  `);
  // db.execute() on this postgres-js driver returns the row array
  // directly, no `.rows` wrapper (verified live 2026-08-22, the same
  // finding fixed in claimArmedMintPlan/testChannelAction/etc.) — using
  // `.rows?.[0]` here would have silently zeroed every tile.
  type CountsRow = {
    live_now: number;
    next_count: number;
    watched: number;
    channels_total: number;
    channels_errored: number;
  };
  const row = ((result as unknown as { rows?: CountsRow[] }).rows ??
    (result as unknown as CountsRow[]))[0];
  return {
    liveNow: row?.live_now ?? 0,
    next: row?.next_count ?? 0,
    watched: row?.watched ?? 0,
    channelsTotal: row?.channels_total ?? 0,
    channelsErrored: row?.channels_errored ?? 0,
  };
}

function StatTile({
  label,
  value,
  tone = "default",
  href,
}: {
  label: string;
  value: string;
  tone?: "default" | "acid" | "amber" | "magenta";
  href?: string;
}) {
  const valueClass =
    tone === "acid"
      ? "text-acid"
      : tone === "amber"
        ? "text-amber"
        : tone === "magenta"
          ? "text-magenta"
          : "text-ink";
  const body = (
    <>
      <dt className="font-mono text-[10px] tracking-wide text-ink-faint uppercase">{label}</dt>
      <dd className={`mt-1 font-display text-2xl font-semibold ${valueClass}`}>{value}</dd>
    </>
  );
  if (href !== undefined) {
    return (
      <a
        href={href}
        className="block rounded-md border border-line bg-base-raised p-3 transition-colors hover:border-acid/40"
      >
        {body}
      </a>
    );
  }
  return <div className="rounded-md border border-line bg-base-raised p-3">{body}</div>;
}

/** Admin → Overview (PRD §7.5): health, queues, scans, latency. */
export default async function AdminOverviewPage() {
  const { db } = container();
  const [providers, scans, outbox, latency, jobStats, counts, mintPlans, rpcEndpoints] =
    await Promise.all([
      listProviders(db).catch(() => []),
      recentScanRuns(db, 10).catch(() => []),
      pendingOutboxDepth(db).catch(() => -1),
      (async () => {
        const started = Date.now();
        await db.execute(sql`select 1`);
        return Date.now() - started;
      })().catch(() => -1),
      db
        .execute(sql`select count(*)::int as c from eligibility_checks`)
        .catch(() => ({ rows: [{ c: 0 }] })),
      overviewCounts(db).catch(
        () =>
          ({
            liveNow: 0,
            next: 0,
            watched: 0,
            channelsTotal: 0,
            channelsErrored: 0,
          }) as OverviewCounts,
      ),
      listMintPlans(db, 200).catch(() => []),
      listRpcEndpoints(db).catch(() => []),
    ]);
  const armedPlans = mintPlans.filter((p) => p.status === "armed").length;
  const rpcEnabled = rpcEndpoints.filter((r) => r.enabled).length;

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Live now" value={String(counts.liveNow)} tone="acid" href="/live" />
        <StatTile label="Next" value={String(counts.next)} href="/next" />
        <StatTile label="Watched" value={String(counts.watched)} href="/watchlist" />
        <StatTile
          label="Armed plans"
          value={String(armedPlans)}
          tone={armedPlans > 0 ? "amber" : "default"}
          href="/admin/execution"
        />
        <StatTile
          label="RPC endpoints"
          value={`${rpcEnabled}/${rpcEndpoints.length}`}
          tone={rpcEnabled === 0 && rpcEndpoints.length > 0 ? "magenta" : "default"}
          href="/admin/execution"
        />
        <StatTile
          label="Alert channels"
          value={
            counts.channelsErrored > 0
              ? `${counts.channelsErrored}/${counts.channelsTotal} erroring`
              : `${counts.channelsTotal} ok`
          }
          tone={counts.channelsErrored > 0 ? "magenta" : "default"}
          href="/admin/alerts"
        />
      </dl>

      <div className="grid gap-3 md:grid-cols-2">
        <section className="rounded-md border border-line bg-base-raised p-4">
          <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
            Providers
          </h2>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] text-ink-faint uppercase">
                <th className="py-1 font-normal">Kind</th>
                <th className="py-1 font-normal">Enabled</th>
                <th className="py-1 font-normal">Health</th>
                <th className="py-1 font-normal">Last success</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {providers.map((p) => (
                <tr key={p.id}>
                  <td className="py-1">{p.kind}</td>
                  <td className="py-1">{p.enabled ? "yes" : "no"}</td>
                  <td
                    className={
                      p.healthStatus === "healthy"
                        ? "text-acid"
                        : p.healthStatus === "down"
                          ? "text-magenta"
                          : "text-amber"
                    }
                  >
                    {p.healthStatus}
                  </td>
                  <td className="py-1 text-ink-faint">{formatDateTimeUtc(p.lastSuccessAt)}</td>
                </tr>
              ))}
              {providers.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-2 text-ink-faint">
                    No providers registered.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

        <section className="rounded-md border border-line bg-base-raised p-4">
          <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
            Runtime
          </h2>
          <dl className="space-y-1 font-mono text-xs">
            <div className="flex justify-between">
              <dt className="text-ink-faint">DB latency</dt>
              <dd>{latency >= 0 ? `${latency}ms` : "down"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-faint">Outbox pending</dt>
              <dd>{outbox >= 0 ? outbox : "n/a"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-faint">Eligibility checks</dt>
              <dd>
                {(
                  ((jobStats as unknown as { rows?: { c: number }[] }).rows ??
                    (jobStats as unknown as { c: number }[]))[0]?.c ?? 0
                ).toLocaleString()}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-[11px] text-ink-faint">
            Queue depth and worker metrics appear at <code>/metrics</code> (Prometheus format).
          </p>
        </section>

        <section className="rounded-md border border-line bg-base-raised p-4 md:col-span-2">
          <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
            Recent scan runs
          </h2>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] text-ink-faint uppercase">
                <th className="py-1 font-normal">Kind</th>
                <th className="py-1 font-normal">Status</th>
                <th className="py-1 font-normal">Started</th>
                <th className="py-1 font-normal">Finished</th>
                <th className="py-1 font-normal">Counts</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {scans.map((s) => (
                <tr key={s.id}>
                  <td className="py-1">{s.kind}</td>
                  <td
                    className={
                      s.status === "success"
                        ? "text-acid"
                        : s.status === "failed"
                          ? "text-magenta"
                          : "text-amber"
                    }
                  >
                    {s.status}
                  </td>
                  <td className="py-1 text-ink-faint">{formatDateTimeUtc(s.startedAt)}</td>
                  <td className="py-1 text-ink-faint">{formatDateTimeUtc(s.finishedAt)}</td>
                  <td className="py-1 text-ink-faint">{JSON.stringify(s.counts ?? {})}</td>
                </tr>
              ))}
              {scans.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-2 text-ink-faint">
                    No scans recorded yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

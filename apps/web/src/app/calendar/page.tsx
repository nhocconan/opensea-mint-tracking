import { queryFeed } from "@hoodmint/db";
import { StatusChip } from "@hoodmint/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { container } from "@/lib/container.ts";
import { formatDateTimeLocal, formatDateTimeUtc, formatPrice, toDate } from "@/lib/format.ts";
import { getSessionUser } from "@/lib/session.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Minting calendar" };

/**
 * Minting Calendar (docs/execution-architecture.md Phase 0 deliverable):
 * an agenda/departure-board grouping of upcoming stages by day. Same
 * underlying feed data as /next (queryFeed view="next") — this is a
 * different lens on it, not a second source of truth. Read-only; no
 * execution affordance lives here.
 */
export default async function CalendarPage() {
  const { db } = container();
  const user = await getSessionUser();
  const page = await queryFeed(db, {
    view: "next",
    sort: "starting",
    limit: 100,
    ...(user !== null ? { userId: user.id } : {}),
  }).catch(() => ({ rows: [], nextCursor: null }));

  // A NEXT project's upcoming stage lives in `nextStageStart`; `stageStartsAt`
  // is the *currently-active* stage (starts_at <= now()), which is null for
  // not-yet-started drops — so keying the calendar off it hid every upcoming
  // drop (found live 2026-08-28). Coalesce: upcoming stage first, else the
  // live stage.
  const stageStart = (row: (typeof page.rows)[number]): Date | string | null =>
    row.nextStageStart ?? row.stageStartsAt;

  const groups = new Map<string, typeof page.rows>();
  for (const row of page.rows) {
    const start = stageStart(row);
    if (start === null) {
      continue;
    }
    const dayKey = toDate(start).toISOString().slice(0, 10);
    const bucket = groups.get(dayKey) ?? [];
    bucket.push(row);
    groups.set(dayKey, bucket);
  }
  const days = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="px-4 py-5">
      <header className="mb-4">
        <h1 className="font-display text-lg font-semibold tracking-tight">Minting calendar</h1>
        <p className="mt-1 text-xs text-ink-muted">
          Every upcoming stage, grouped by day. Local time first, UTC on hover — same feed as{" "}
          <Link href="/next" className="text-cyan hover:underline">
            Next
          </Link>
          , different lens.
        </p>
      </header>

      {days.length === 0 ? (
        <div className="rounded-md border border-line bg-base-raised p-4 text-sm text-ink-faint">
          No upcoming stages discovered yet. Run a scan or check{" "}
          <Link href="/next" className="text-cyan hover:underline">
            Next
          </Link>
          .
        </div>
      ) : (
        <div className="space-y-4">
          {days.map(([dayKey, rows]) => (
            <section key={dayKey} className="rounded-md border border-line bg-base-raised">
              <h2 className="border-b border-line px-3 py-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
                {new Date(`${dayKey}T00:00:00Z`).toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "2-digit",
                  timeZone: "UTC",
                })}{" "}
                · {dayKey} UTC
              </h2>
              <table className="w-full text-left text-xs">
                <caption className="sr-only">
                  Mint stages starting{" "}
                  {new Date(`${dayKey}T00:00:00Z`).toLocaleDateString(undefined, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    timeZone: "UTC",
                  })}
                </caption>
                <thead className="sr-only">
                  <tr>
                    <th scope="col">Local start time</th>
                    <th scope="col">Project</th>
                    <th scope="col">Stage</th>
                    <th scope="col">Price</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line font-mono">
                  {rows.map((row) => {
                    const start = stageStart(row);
                    return (
                      <tr key={`${row.id}:${start !== null ? toDate(start).toISOString() : ""}`}>
                        <td
                          className="w-24 py-2 pl-3 text-ink-muted"
                          title={formatDateTimeUtc(start)}
                        >
                          {formatDateTimeLocal(start)}
                        </td>
                        <td className="py-2">
                          <Link href={`/projects/${row.id}`} className="text-ink hover:text-acid">
                            {row.name}
                          </Link>
                        </td>
                        <td className="py-2 text-ink-faint">{row.stageLabel ?? "—"}</td>
                        <td className="py-2 text-ink-faint">
                          {formatPrice(row.stagePriceWei ?? row.nextStagePriceWei)}
                        </td>
                        <td className="w-20 py-2 pr-3">
                          <StatusChip status={row.lifecycleStatus} stale={false} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

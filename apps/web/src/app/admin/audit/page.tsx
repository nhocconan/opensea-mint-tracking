import { countAuditLogs, listAuditLogs } from "@hoodmint/db";
import { PAGE_SIZE, Pagination, SearchBox } from "@/components/list-controls.tsx";
import { parsePage } from "@/lib/admin-validation.ts";
import { container } from "@/lib/container.ts";
import { formatDateTimeUtc } from "@/lib/format.ts";

export const dynamic = "force-dynamic";

/** Admin → Audit log (PRD §7.5): actor/action/target/result/correlation. */
export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const search = typeof params.q === "string" ? params.q : "";
  const page = parsePage(typeof params.page === "string" ? params.page : undefined);
  const { db } = container();
  const [logs, total] = await Promise.all([
    listAuditLogs(db, { search, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }).catch(() => []),
    countAuditLogs(db, { search }).catch(() => 0),
  ]);

  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Audit log
        </h2>
        <SearchBox
          value={search}
          label="Search audit log by actor, action, or target"
          placeholder="actor, action, or target…"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[10px] text-ink-faint uppercase">
              <th scope="col" className="py-1 font-normal">
                When (UTC)
              </th>
              <th scope="col" className="py-1 font-normal">
                Actor
              </th>
              <th scope="col" className="py-1 font-normal">
                Action
              </th>
              <th scope="col" className="py-1 font-normal">
                Target
              </th>
              <th scope="col" className="py-1 font-normal">
                Result
              </th>
              <th scope="col" className="py-1 font-normal">
                Correlation
              </th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {logs.map((log) => (
              <tr key={log.id}>
                <td className="py-1 text-ink-faint">{formatDateTimeUtc(log.createdAt)}</td>
                <td className="py-1">{log.actorUserId?.slice(0, 8) ?? "system"}</td>
                <td className="py-1">{log.action}</td>
                <td className="py-1 text-ink-muted">
                  {log.targetType}
                  {log.targetId !== null ? `:${log.targetId.slice(0, 12)}` : ""}
                </td>
                <td className={log.result === "success" ? "text-acid" : "text-magenta"}>
                  {log.result}
                </td>
                <td className="py-1 text-ink-faint">{log.correlationId?.slice(0, 8) ?? "—"}</td>
              </tr>
            ))}
            {logs.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-2 text-ink-faint">
                  {search !== "" ? "No audit entries match that search." : "No audit entries yet."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={total} query={search !== "" ? { q: search } : {}} />
      <p className="mt-3 text-[11px] text-ink-faint">
        Metadata is redacted before storage; before/after secret values are never recorded.
      </p>
    </section>
  );
}

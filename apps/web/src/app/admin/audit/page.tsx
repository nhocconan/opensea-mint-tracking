import { recentAuditLogs } from "@hoodmint/db";
import { container } from "@/lib/container.ts";
import { formatDateTimeUtc } from "@/lib/format.ts";

export const dynamic = "force-dynamic";

/** Admin → Audit log (PRD §7.5): actor/action/target/result/correlation. */
export default async function AdminAuditPage() {
  const { db } = container();
  const logs = await recentAuditLogs(db, 100).catch(() => []);

  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        Audit log (latest 100)
      </h2>
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="text-[10px] text-ink-faint uppercase">
            <th className="py-1 font-normal">When (UTC)</th>
            <th className="py-1 font-normal">Actor</th>
            <th className="py-1 font-normal">Action</th>
            <th className="py-1 font-normal">Target</th>
            <th className="py-1 font-normal">Result</th>
            <th className="py-1 font-normal">Correlation</th>
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
                No audit entries yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <p className="mt-3 text-[11px] text-ink-faint">
        Metadata is redacted before storage; before/after secret values are never recorded.
      </p>
    </section>
  );
}

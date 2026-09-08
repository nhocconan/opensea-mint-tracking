import { listProviders } from "@hoodmint/db";
import Link from "next/link";
import { container } from "@/lib/container.ts";
import { formatDateTime } from "@/lib/format.ts";
import { ProviderToggle } from "./provider-toggle.tsx";
import { TrackDropForm } from "./track-drop-form.tsx";

export const dynamic = "force-dynamic";

/** Admin → Sources (PRD §7.5): enable/disable providers, health, last errors. */
export default async function AdminSourcesPage() {
  const { db, config } = container();
  const providers = await listProviders(db).catch(() => []);

  return (
    <div className="grid gap-3">
      <TrackDropForm />
      <section className="rounded-md border border-line bg-base-raised p-4">
        <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Discovery sources
        </h2>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[10px] text-ink-faint uppercase">
              <th className="py-1 font-normal">Kind</th>
              <th className="py-1 font-normal">Enabled</th>
              <th className="py-1 font-normal">Health</th>
              <th className="py-1 font-normal">Last success (GMT+7)</th>
              <th className="py-1 font-normal">Last error</th>
              <th className="py-1 font-normal">Toggle</th>
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
                <td className="py-1 text-ink-faint">{formatDateTime(p.lastSuccessAt)}</td>
                <td className="py-1 text-magenta/80">{p.lastErrorCode ?? "—"}</td>
                <td className="py-1">
                  <ProviderToggle kind={p.kind} enabled={p.enabled} />
                </td>
              </tr>
            ))}
            {providers.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-2 text-ink-faint">
                  No providers — they register on first worker cycle.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="rounded-md border border-line bg-base-raised p-4 font-mono text-xs text-ink-muted">
        <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          External radar integrations
        </h2>
        <div className="flex items-center justify-between border-t border-line/60 pt-2">
          <div>
            <div className="font-semibold text-ink">NeverFuckingTrade (NFT Trencher)</div>
            <div className="text-[11px] text-ink-faint">
              Cross-chain live mint radar &amp; whitelist checker API
            </div>
          </div>
          <Link
            href="/admin/nvt"
            className="rounded-sm border border-cyan/40 bg-cyan/10 px-2.5 py-1 text-xs text-cyan hover:bg-cyan/20"
          >
            Configure &rarr;
          </Link>
        </div>
      </section>

      <section className="rounded-md border border-line bg-base-raised p-4 font-mono text-xs text-ink-muted">
        <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Effective polling policy
        </h2>
        <dl className="space-y-1">
          <div className="flex justify-between">
            <dt className="text-ink-faint">Discovery interval</dt>
            <dd>{config.DISCOVERY_INTERVAL_SECONDS}s</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-faint">Max pages / list call</dt>
            <dd>{config.OPENSEA_MAX_PAGES}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-faint">Quota reserve</dt>
            <dd>{config.OPENSEA_RATE_RESERVE_PERCENT}%</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-faint">RPC configured</dt>
            <dd>{config.RPC_URL ? "yes" : "no (set RPC_URL for on-chain radar)"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-faint">Chain sync interval</dt>
            <dd>{config.CHAIN_SYNC_INTERVAL_SECONDS}s</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

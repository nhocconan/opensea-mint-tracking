import { listWallets } from "@hoodmint/db";
import { container } from "@/lib/container.ts";
import { formatDateTimeUtc, shortAddress } from "@/lib/format.ts";
import { WalletForm } from "./wallet-form.tsx";

export const dynamic = "force-dynamic";

/** Admin → Wallets (PRD §7.5): display-only addresses + auth assignment. */
export default async function AdminWalletsPage() {
  const { db, config } = container();
  const wallets = await listWallets(db).catch(() => []);
  const prefill =
    config.APP_ENV === "development" && config.DEFAULT_WALLET_ADDRESS !== undefined
      ? config.DEFAULT_WALLET_ADDRESS
      : "";

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <WalletForm prefill={prefill} />

      <section className="rounded-md border border-line bg-base-raised p-4">
        <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Tracked wallets
        </h2>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[10px] text-ink-faint uppercase">
              <th className="py-1 font-normal">Address</th>
              <th className="py-1 font-normal">Label</th>
              <th className="py-1 font-normal">Enabled</th>
              <th className="py-1 font-normal">Added</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {wallets.map((w) => (
              <tr key={w.id}>
                <td className="py-1" title={w.address}>
                  {shortAddress(w.address)}
                </td>
                <td className="py-1">{w.label ?? "—"}</td>
                <td className={w.enabled ? "text-acid" : "text-ink-faint"}>
                  {w.enabled ? "yes" : "no"}
                </td>
                <td className="py-1 text-ink-faint">{formatDateTimeUtc(w.createdAt)}</td>
              </tr>
            ))}
            {wallets.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-2 text-ink-faint">
                  No wallets yet — eligibility needs at least one.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <p className="mt-3 text-[11px] text-ink-faint">
          Addresses are display-only. The app never asks for private keys or seed phrases.
        </p>
      </section>
    </div>
  );
}

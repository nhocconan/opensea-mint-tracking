import { countWallets, listWallets } from "@hoodmint/db";
import { PAGE_SIZE, Pagination, SearchBox } from "@/components/list-controls.tsx";
import { parsePage } from "@/lib/admin-validation.ts";
import { container } from "@/lib/container.ts";
import { formatDateTimeUtc, shortAddress } from "@/lib/format.ts";
import { BulkWalletForm } from "./bulk-wallet-form.tsx";
import { ImportKeyForm } from "./import-key-form.tsx";
import { RemoveKeyButton } from "./remove-key-button.tsx";
import { WalletForm } from "./wallet-form.tsx";
import { WalletLabelCell, WalletRowActions } from "./wallet-row-actions.tsx";

export const dynamic = "force-dynamic";

/** Admin → Wallets (PRD §7.5): display-only addresses + auth assignment. */
export default async function AdminWalletsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const search = typeof params.q === "string" ? params.q : "";
  const page = parsePage(typeof params.page === "string" ? params.page : undefined);
  const { db, config } = container();
  const [wallets, total] = await Promise.all([
    listWallets(db, { search, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }).catch(() => []),
    countWallets(db, { search }).catch(() => 0),
  ]);
  const prefill =
    config.APP_ENV === "development" && config.DEFAULT_WALLET_ADDRESS !== undefined
      ? config.DEFAULT_WALLET_ADDRESS
      : "";

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <WalletForm prefill={prefill} />
      <BulkWalletForm />
      <ImportKeyForm envelopeSealing={config.WALLET_KEY_PUBLIC_KEY !== undefined} />

      <section className="rounded-md border border-line bg-base-raised p-4 md:col-span-2">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
            Tracked wallets
          </h2>
          <SearchBox
            value={search}
            label="Search wallets by address or label"
            placeholder="address or label…"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] text-ink-faint uppercase">
                <th scope="col" className="py-1 font-normal">
                  Address
                </th>
                <th scope="col" className="py-1 font-normal">
                  Label
                </th>
                <th scope="col" className="py-1 font-normal">
                  Enabled
                </th>
                <th scope="col" className="py-1 font-normal">
                  Minting
                </th>
                <th scope="col" className="py-1 font-normal">
                  Added
                </th>
                <th scope="col" className="py-1 font-normal">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {wallets.map((w) => (
                <tr key={w.id}>
                  <td className="py-1" title={w.address}>
                    {shortAddress(w.address)}
                  </td>
                  <td className="py-1">
                    <WalletLabelCell id={w.id} label={w.label} />
                  </td>
                  <td className={w.enabled ? "text-acid" : "text-ink-faint"}>
                    {w.enabled ? "yes" : "no"}
                  </td>
                  <td className="py-1">
                    {w.hasSigningKey ? (
                      <span className="flex items-center gap-2">
                        <span
                          className="rounded-xs border border-acid/40 px-1 text-[10px] text-acid"
                          title={w.signingKeyFingerprint ?? undefined}
                        >
                          managed
                        </span>
                        {w.signingKeySealedWith === "aes-256-gcm" ? (
                          <span
                            className="rounded-xs border border-amber/40 px-1 text-[10px] text-amber"
                            title="Sealed with the shared APP_ENCRYPTION_KEY (web can decrypt). The worker re-seals it to the worker-only key automatically once WALLET_KEY_* are configured."
                          >
                            legacy seal
                          </span>
                        ) : null}
                        <RemoveKeyButton walletId={w.id} />
                      </span>
                    ) : (
                      <span className="text-ink-faint">tracking only</span>
                    )}
                  </td>
                  <td className="py-1 text-ink-faint">{formatDateTimeUtc(w.createdAt)}</td>
                  <td className="py-1">
                    <WalletRowActions
                      id={w.id}
                      address={w.address}
                      enabled={w.enabled}
                      hasSigningKey={w.hasSigningKey}
                    />
                  </td>
                </tr>
              ))}
              {wallets.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-2 text-ink-faint">
                    {search !== ""
                      ? "No wallets match that search."
                      : "No wallets yet — eligibility needs at least one."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <Pagination page={page} total={total} query={search !== "" ? { q: search } : {}} />
        <p className="mt-3 text-[11px] text-ink-faint">
          Tracking-only wallets are display addresses for eligibility. A{" "}
          <span className="text-acid">managed</span> wallet additionally holds an encrypted signing
          key (burner only) used for autonomous minting — see Import minting key above.
        </p>
      </section>
    </div>
  );
}

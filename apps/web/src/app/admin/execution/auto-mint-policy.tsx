"use client";

import type { AutoMintPolicy } from "@hoodmint/core";
import { useState, useTransition } from "react";
import { saveAutoMintPolicyAction } from "@/app/actions.ts";
import { authClient } from "@/lib/auth-client.ts";

interface WalletOption {
  readonly id: string;
  readonly address: string;
  readonly label: string | null;
  readonly hasSigningKey: boolean;
}

/**
 * Auto-mint policy: turn listed MANAGED wallets into autonomous free-mint
 * snipers with scam + quality gates. Saving is a spend-capable change, so it
 * runs the passkey step-up first (same as arming / importing a key).
 */
export function AutoMintPolicyPanel({
  policy,
  wallets,
}: {
  policy: AutoMintPolicy;
  wallets: readonly WalletOption[];
}) {
  const managed = wallets.filter((w) => w.hasSigningKey);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <section className="rounded-md border border-acid/30 bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-acid uppercase">
        Auto-mint policy (burner sniper)
      </h2>
      <p className="mt-1 text-[11px] text-ink-muted">
        Automatically plan + arm mints on the managed wallets below for drops that match: by default
        <strong> free, public</strong> stages, listed in OpenSea's curated drops feed, not flagged
        as scam by Grok. The pre-sign engine fires them at the open instant. Requires the
        live-execution switch to actually broadcast.
      </p>
      <form
        className="mt-3 grid gap-2 md:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          startTransition(async () => {
            setStatus(null);
            const signIn = await authClient.signIn.passkey();
            if (signIn?.error) {
              setStatus({
                ok: false,
                message: signIn.error.message ?? "Passkey verification failed or was cancelled.",
              });
              return;
            }
            setStatus(
              await saveAutoMintPolicyAction({
                enabled: f.get("enabled") === "on",
                walletIds: f.getAll("walletIds").map(String),
                maxPriceWei: String(f.get("maxPriceWei") ?? "0"),
                publicOnly: f.get("publicOnly") === "on",
                maxRiskScore: Number(f.get("maxRiskScore") ?? 40),
                requireRiskSignal: f.get("requireRiskSignal") === "on",
                requireCuratedListing: f.get("requireCuratedListing") === "on",
                minHypeScore: Number(f.get("minHypeScore") ?? 0),
                minUniqueMintersLive: Number(f.get("minUniqueMintersLive") ?? 0),
                lookaheadHours: Number(f.get("lookaheadHours") ?? 24),
                maxPerWalletPerDay: Number(f.get("maxPerWalletPerDay") ?? 20),
                quantity: Number(f.get("quantity") ?? 1),
              }),
            );
          });
        }}
      >
        <label className="flex items-center gap-2 text-sm md:col-span-2">
          <input type="checkbox" name="enabled" defaultChecked={policy.enabled} />
          <span className="font-mono text-xs text-acid">ENABLED</span>
        </label>

        <fieldset className="md:col-span-2">
          <legend className="mb-1 text-[11px] text-ink-muted">Managed wallets to mint with</legend>
          {managed.length === 0 ? (
            <p className="text-[11px] text-amber">
              No managed wallets — import a burner key in Admin → Wallets first.
            </p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {managed.map((w) => (
                <label key={w.id} className="flex items-center gap-1 font-mono text-[11px]">
                  <input
                    type="checkbox"
                    name="walletIds"
                    value={w.id}
                    defaultChecked={policy.walletIds.includes(w.id)}
                  />
                  {w.label ?? `${w.address.slice(0, 6)}…${w.address.slice(-4)}`}
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-muted">
            Max price (wei; 0 = free only)
          </span>
          <input
            name="maxPriceWei"
            defaultValue={policy.maxPriceWei}
            pattern="[0-9]+"
            className="w-full rounded-sm border border-line bg-base px-2 py-1 font-mono text-xs"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-muted">Max Grok risk score (0–100)</span>
          <input
            name="maxRiskScore"
            type="number"
            min={0}
            max={100}
            defaultValue={policy.maxRiskScore}
            className="w-full rounded-sm border border-line bg-base px-2 py-1 font-mono text-xs"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-muted">
            Min Grok hype score (0 = off)
          </span>
          <input
            name="minHypeScore"
            type="number"
            min={0}
            max={100}
            defaultValue={policy.minHypeScore}
            className="w-full rounded-sm border border-line bg-base px-2 py-1 font-mono text-xs"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-muted">
            Min unique minters/1h once live (0 = off)
          </span>
          <input
            name="minUniqueMintersLive"
            type="number"
            min={0}
            max={10000}
            defaultValue={policy.minUniqueMintersLive}
            className="w-full rounded-sm border border-line bg-base px-2 py-1 font-mono text-xs"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-muted">Lookahead (hours)</span>
          <input
            name="lookaheadHours"
            type="number"
            min={1}
            max={168}
            defaultValue={policy.lookaheadHours}
            className="w-full rounded-sm border border-line bg-base px-2 py-1 font-mono text-xs"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-muted">
            Max mints per wallet per day
          </span>
          <input
            name="maxPerWalletPerDay"
            type="number"
            min={1}
            max={500}
            defaultValue={policy.maxPerWalletPerDay}
            className="w-full rounded-sm border border-line bg-base px-2 py-1 font-mono text-xs"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-muted">Quantity per mint</span>
          <input
            name="quantity"
            type="number"
            min={1}
            max={10}
            defaultValue={policy.quantity}
            className="w-full rounded-sm border border-line bg-base px-2 py-1 font-mono text-xs"
          />
        </label>
        <div className="flex flex-col gap-1 text-[11px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="publicOnly" defaultChecked={policy.publicOnly} /> Public
            stages only
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="requireCuratedListing"
              defaultChecked={policy.requireCuratedListing}
            />{" "}
            Only OpenSea-curated drops (quality gate)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="requireRiskSignal"
              defaultChecked={policy.requireRiskSignal}
            />{" "}
            Strict: require a Grok risk read before minting
          </label>
        </div>

        <div className="md:col-span-2 flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
          >
            {pending ? "Verifying…" : "Verify passkey + save policy"}
          </button>
          {status !== null ? (
            <span
              role={status.ok ? "status" : "alert"}
              className={`text-xs ${status.ok ? "text-acid" : "text-magenta"}`}
            >
              {status.message}
            </span>
          ) : null}
        </div>
      </form>
    </section>
  );
}

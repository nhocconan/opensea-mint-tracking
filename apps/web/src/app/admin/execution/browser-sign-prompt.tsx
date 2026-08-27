"use client";

import { useState, useTransition } from "react";
import { recordBrowserSignatureAction } from "@/app/actions.ts";

/** Minimal EIP-1193 shape — every browser extension wallet injects this. */
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export interface PendingSignature {
  readonly attemptId: string;
  readonly to: string;
  readonly data: string;
  readonly valueWei: string;
  readonly chainId: number;
}

/**
 * The last step of Phase 1 (ADR 0008): a real, unsigned transaction the
 * pipeline already simulated, waiting for the owner's OWN browser wallet.
 * This component never holds a key — it hands calldata to
 * `window.ethereum` (MetaMask, Rabby, a Ledger connected via a browser
 * wallet, etc.) and the wallet's own UI is where the owner actually
 * approves. Nothing here can sign or broadcast on its own.
 */
export function BrowserSignPrompt({ attemptId, to, data, valueWei, chainId }: PendingSignature) {
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="rounded-sm border border-magenta/30 bg-magenta/5 p-3">
      <p className="font-mono text-[11px] text-ink-muted">
        Chain {chainId} · to <span className="text-ink">{to}</span> · value {valueWei} wei
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setStatus(null);
            if (typeof window === "undefined" || window.ethereum === undefined) {
              setStatus({
                ok: false,
                message: "No browser wallet detected — install MetaMask or similar.",
              });
              return;
            }
            const eth = window.ethereum;
            try {
              const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
              const from = accounts[0];
              if (from === undefined) {
                setStatus({ ok: false, message: "Wallet returned no account." });
                return;
              }
              const currentChainHex = (await eth.request({ method: "eth_chainId" })) as string;
              const targetChainHex = `0x${chainId.toString(16)}`;
              if (currentChainHex.toLowerCase() !== targetChainHex.toLowerCase()) {
                await eth.request({
                  method: "wallet_switchEthereumChain",
                  params: [{ chainId: targetChainHex }],
                });
              }
              const valueHex = `0x${BigInt(valueWei).toString(16)}`;
              const txHash = (await eth.request({
                method: "eth_sendTransaction",
                params: [{ from, to, data, value: valueHex }],
              })) as string;
              const result = await recordBrowserSignatureAction(attemptId, txHash);
              setStatus(result);
            } catch (error) {
              setStatus({
                ok: false,
                message:
                  error instanceof Error
                    ? error.message
                    : "Wallet rejected the request or an error occurred.",
              });
            }
          })
        }
        className="mt-2 rounded-sm border border-magenta/50 bg-magenta/15 px-3 py-1.5 font-mono text-xs text-magenta hover:bg-magenta/25 disabled:opacity-50"
      >
        {pending ? "Waiting on wallet…" : "Connect wallet & sign"}
      </button>
      {status !== null ? (
        <p
          role={status.ok ? "status" : "alert"}
          className={`mt-2 text-xs ${status.ok ? "text-acid" : "text-magenta"}`}
        >
          {status.message}
        </p>
      ) : null}
    </div>
  );
}

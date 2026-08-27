"use client";

import { useState, useTransition } from "react";
import {
  activateExecutorSignerAction,
  prepareSetAllowlistCalldataAction,
  prepareSetOperatorCalldataAction,
  recordExecutorDeployedAction,
  startExecutorOnboardingAction,
} from "@/app/actions.ts";

/** Minimal EIP-1193 shape — same as browser-sign-prompt.tsx, generalized
 *  here beyond mint-plan execution attempts: deploy + owner-only contract
 *  calls, not just a mint transaction. */
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

type Step = "start" | "deploy" | "set-operator" | "allowlist" | "activate" | "done";

interface Msg {
  readonly ok: boolean;
  readonly text: string;
}

/** Sends a transaction via the connected browser wallet and waits for it
 *  to confirm (polls the receipt) — used for every owner-signed step here.
 *  `to: null` means a contract-creation transaction. */
async function sendAndConfirm(
  eth: Eip1193Provider,
  chainId: number,
  tx: { to: string | null; data: string },
): Promise<{ txHash: string; contractAddress: string | null }> {
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const from = accounts[0];
  if (from === undefined) {
    throw new Error("Wallet returned no account.");
  }
  const currentChainHex = (await eth.request({ method: "eth_chainId" })) as string;
  const targetChainHex = `0x${chainId.toString(16)}`;
  if (currentChainHex.toLowerCase() !== targetChainHex.toLowerCase()) {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: targetChainHex }],
    });
  }
  const params: Record<string, unknown> = { from, data: tx.data };
  if (tx.to !== null) {
    params.to = tx.to;
  }
  const txHash = (await eth.request({ method: "eth_sendTransaction", params: [params] })) as string;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const receipt = (await eth.request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
    })) as { status: string; contractAddress: string | null } | null;
    if (receipt !== null) {
      if (receipt.status !== "0x1") {
        throw new Error(`Transaction reverted on-chain (${txHash}).`);
      }
      return { txHash, contractAddress: receipt.contractAddress };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for confirmation of ${txHash} — check your wallet/explorer.`);
}

export function ExecutorOnboarding({ defaultChainId }: { defaultChainId: number }) {
  const [step, setStep] = useState<Step>("start");
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<Msg | null>(null);

  const [ownerAddress, setOwnerAddress] = useState("");
  const [signerId, setSignerId] = useState<string | null>(null);
  const [operatorAddress, setOperatorAddress] = useState<string | null>(null);
  const [deployData, setDeployData] = useState<string | null>(null);
  const [executorAddress, setExecutorAddress] = useState<string | null>(null);

  const [target, setTarget] = useState("");
  const [selector, setSelector] = useState("");
  const [recipientOffset, setRecipientOffset] = useState("4");
  const [valueCapWei, setValueCapWei] = useState("");
  const [allowlistedCount, setAllowlistedCount] = useState(0);

  const [activateCapWei, setActivateCapWei] = useState("");

  function requireWallet(): Eip1193Provider | null {
    if (typeof window === "undefined" || window.ethereum === undefined) {
      setMsg({ ok: false, text: "No browser wallet detected — install MetaMask or similar." });
      return null;
    }
    return window.ethereum;
  }

  return (
    <section
      aria-labelledby="executor-onboarding"
      className="rounded-md border border-magenta/30 bg-magenta/5 p-4"
    >
      <h2
        id="executor-onboarding"
        className="mb-2 font-mono text-[11px] tracking-widest text-magenta uppercase"
      >
        Delegated custody onboarding (custom_executor)
      </h2>
      <p className="mb-3 text-xs text-ink-muted">
        ADR 0004 Phase 2. Every step below is individually reviewed and signed by YOUR own wallet
        (Ledger via MetaMask/Rabby/etc.) — nothing here auto-signs. Once activated, the hot session
        key can fire mints with no human in the loop, bounded by the on-chain allowlist, recipient
        pin, and value cap. Deploy this on a real chain from a Ledger you control.
      </p>

      {msg !== null ? (
        <p
          role={msg.ok ? "status" : "alert"}
          className={`mb-3 text-xs ${msg.ok ? "text-acid" : "text-magenta"}`}
        >
          {msg.text}
        </p>
      ) : null}

      {step === "start" ? (
        <div className="space-y-2">
          <label className="block font-mono text-[11px] text-ink-faint" htmlFor="exec-owner">
            Owner address (your Ledger's EOA)
          </label>
          <input
            id="exec-owner"
            type="text"
            value={ownerAddress}
            onChange={(e) => setOwnerAddress(e.target.value)}
            placeholder="0x…"
            className="w-full rounded-sm border border-line bg-base px-2 py-1 font-mono text-xs"
          />
          <button
            type="button"
            disabled={pending || !/^0x[0-9a-fA-F]{40}$/.test(ownerAddress.trim())}
            onClick={() =>
              startTransition(async () => {
                const result = await startExecutorOnboardingAction(ownerAddress.trim());
                if (!result.ok || result.data === undefined) {
                  setMsg({ ok: false, text: result.message });
                  return;
                }
                setSignerId(result.data.signerId);
                setOperatorAddress(result.data.operatorAddress);
                setDeployData(result.data.deployData);
                setMsg({ ok: true, text: result.message });
                setStep("deploy");
              })
            }
            className="rounded-sm border border-magenta/50 bg-magenta/15 px-3 py-1.5 font-mono text-xs text-magenta hover:bg-magenta/25 disabled:opacity-50"
          >
            {pending ? "Generating session key…" : "1. Generate session key"}
          </button>
        </div>
      ) : null}

      {step === "deploy" && deployData !== null ? (
        <div className="space-y-2">
          <p className="font-mono text-[11px] text-ink-muted">
            Operator (session key) address: <span className="text-ink">{operatorAddress}</span> —
            safe to note down, this is not the secret.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const eth = requireWallet();
                if (eth === null) return;
                try {
                  const { contractAddress } = await sendAndConfirm(eth, defaultChainId, {
                    to: null,
                    data: deployData,
                  });
                  if (contractAddress === null || signerId === null) {
                    setMsg({
                      ok: false,
                      text: "Deploy confirmed but no contract address returned.",
                    });
                    return;
                  }
                  const result = await recordExecutorDeployedAction(signerId, contractAddress);
                  setMsg({ ok: result.ok, text: result.message });
                  if (result.ok) {
                    setExecutorAddress(contractAddress);
                    setStep("set-operator");
                  }
                } catch (error) {
                  setMsg({
                    ok: false,
                    text: error instanceof Error ? error.message : "Deploy failed.",
                  });
                }
              })
            }
            className="rounded-sm border border-magenta/50 bg-magenta/15 px-3 py-1.5 font-mono text-xs text-magenta hover:bg-magenta/25 disabled:opacity-50"
          >
            {pending ? "Waiting on wallet…" : "2. Deploy Executor (sign with your wallet)"}
          </button>
        </div>
      ) : null}

      {step === "set-operator" && executorAddress !== null && operatorAddress !== null ? (
        <div className="space-y-2">
          <p className="font-mono text-[11px] text-ink-muted">
            Executor deployed: <span className="text-ink">{executorAddress}</span>
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const eth = requireWallet();
                if (eth === null) return;
                const prep = await prepareSetOperatorCalldataAction(operatorAddress);
                if (!prep.ok || prep.data === undefined) {
                  setMsg({ ok: false, text: prep.message });
                  return;
                }
                try {
                  await sendAndConfirm(eth, defaultChainId, {
                    to: executorAddress,
                    data: prep.data,
                  });
                  setMsg({ ok: true, text: "Operator set on-chain." });
                  setStep("allowlist");
                } catch (error) {
                  setMsg({
                    ok: false,
                    text: error instanceof Error ? error.message : "setOperator failed.",
                  });
                }
              })
            }
            className="rounded-sm border border-magenta/50 bg-magenta/15 px-3 py-1.5 font-mono text-xs text-magenta hover:bg-magenta/25 disabled:opacity-50"
          >
            {pending ? "Waiting on wallet…" : "3. setOperator (sign with your wallet)"}
          </button>
        </div>
      ) : null}

      {(step === "allowlist" || step === "activate") && executorAddress !== null ? (
        <div className="space-y-3">
          <div className="space-y-2 border-t border-magenta/20 pt-3">
            <p className="font-mono text-[11px] text-ink-faint uppercase">
              Allowlist one collection ({allowlistedCount} added so far — never batched)
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                type="text"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="Target contract 0x…"
                aria-label="Target contract address"
                className="rounded-sm border border-line bg-base px-2 py-1 font-mono text-xs"
              />
              <input
                type="text"
                value={selector}
                onChange={(e) => setSelector(e.target.value)}
                placeholder="Selector 0x40c10f19"
                aria-label="Function selector"
                className="rounded-sm border border-line bg-base px-2 py-1 font-mono text-xs"
              />
              <input
                type="number"
                value={recipientOffset}
                onChange={(e) => setRecipientOffset(e.target.value)}
                placeholder="Recipient offset (bytes)"
                aria-label="Recipient offset in bytes"
                className="rounded-sm border border-line bg-base px-2 py-1 font-mono text-xs"
              />
              <input
                type="text"
                value={valueCapWei}
                onChange={(e) => setValueCapWei(e.target.value)}
                placeholder="Value cap, wei (24h rolling)"
                aria-label="Value cap in wei"
                className="rounded-sm border border-line bg-base px-2 py-1 font-mono text-xs"
              />
            </div>
            <button
              type="button"
              disabled={pending || !target || !selector || !valueCapWei}
              onClick={() =>
                startTransition(async () => {
                  const eth = requireWallet();
                  if (eth === null) return;
                  const prep = await prepareSetAllowlistCalldataAction({
                    target,
                    selector,
                    recipientOffset: Number.parseInt(recipientOffset, 10),
                    valueCapWei,
                  });
                  if (!prep.ok || prep.data === undefined) {
                    setMsg({ ok: false, text: prep.message });
                    return;
                  }
                  try {
                    await sendAndConfirm(eth, defaultChainId, {
                      to: executorAddress,
                      data: prep.data,
                    });
                    setMsg({ ok: true, text: `Allowlisted ${target} / ${selector}.` });
                    setAllowlistedCount((n) => n + 1);
                    setActivateCapWei(valueCapWei);
                    setTarget("");
                    setSelector("");
                    setStep("activate");
                  } catch (error) {
                    setMsg({
                      ok: false,
                      text: error instanceof Error ? error.message : "setAllowlist failed.",
                    });
                  }
                })
              }
              className="rounded-sm border border-magenta/50 bg-magenta/15 px-3 py-1.5 font-mono text-xs text-magenta hover:bg-magenta/25 disabled:opacity-50"
            >
              {pending ? "Waiting on wallet…" : "4. setAllowlist for this collection"}
            </button>
          </div>

          {step === "activate" && signerId !== null ? (
            <div className="space-y-2 border-t border-magenta/20 pt-3">
              <label className="block font-mono text-[11px] text-ink-faint" htmlFor="exec-cap">
                Signer's coarse on-chain ceiling (wei) — must match what setAllowlist actually set
              </label>
              <input
                id="exec-cap"
                type="text"
                value={activateCapWei}
                onChange={(e) => setActivateCapWei(e.target.value)}
                className="w-full rounded-sm border border-line bg-base px-2 py-1 font-mono text-xs"
              />
              <button
                type="button"
                disabled={pending || !activateCapWei}
                onClick={() =>
                  startTransition(async () => {
                    const result = await activateExecutorSignerAction(signerId, activateCapWei);
                    setMsg({ ok: result.ok, text: result.message });
                    if (result.ok) {
                      setStep("done");
                    }
                  })
                }
                className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
              >
                {pending
                  ? "Activating…"
                  : "5. Activate signer (I confirmed every step above landed on-chain)"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {step === "done" ? (
        <p className="font-mono text-xs text-acid">
          Signer activated. It appears in the Signers table above and is now eligible for live
          execution when LIVE_EXECUTION_ENABLED is set.
        </p>
      ) : null}
    </section>
  );
}

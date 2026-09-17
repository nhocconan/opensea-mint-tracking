import { describe, expect, it } from "vitest";
import {
  isPerWalletLimitError,
  isTerminalMintBuildError,
  mintedOutIsTerminal,
  precheckAllowance,
} from "./mint-tx.ts";
import { preBuildBackoffMs } from "./workers/pre-build.ts";

describe("isTerminalMintBuildError", () => {
  it("is terminal only for answers about the whole drop", () => {
    expect(isTerminalMintBuildError("minted out")).toBe(true);
    expect(isTerminalMintBuildError("provider returned 422: sold out")).toBe(true);
    expect(isTerminalMintBuildError("Insufficient balance to mint")).toBe(true);
  });

  // The defect this locks down, found live 2026-09-15 on exit-founders:
  // max_per_wallet is CUMULATIVE across phases, so a wallet holding 1 from a
  // GTD phase is refused at 2 on the FCFS phase while 1 would have worked.
  // Treating that as terminal marked the plan permanently failed and threw
  // away a mint the operator was entitled to. It is also what a still-active
  // EARLIER phase answers about a plan aimed at a LATER one.
  it("is NOT terminal for a per-wallet limit, at any phrasing", () => {
    for (const message of [
      "exceeds max per wallet",
      "provider returned 422: exceeds max per wallet for this stage",
      "Exceeds maximum per wallet",
      "wallet has already minted",
      "provider returned 400: exceeds the allowance",
    ]) {
      expect(isTerminalMintBuildError(message)).toBe(false);
      expect(isPerWalletLimitError(message)).toBe(true);
    }
  });

  it("does not classify an unrelated failure as either", () => {
    expect(isTerminalMintBuildError("HTTP request failed")).toBe(false);
    expect(isPerWalletLimitError("HTTP request failed")).toBe(false);
    expect(isTerminalMintBuildError("execution reverted")).toBe(false);
  });

  it("keeps whole-drop terminals out of the per-wallet class", () => {
    expect(isPerWalletLimitError("minted out")).toBe(false);
    expect(isPerWalletLimitError("sold out")).toBe(false);
  });
});

describe("mintedOutIsTerminal", () => {
  const T = 1_800_000_000_000;

  // The defect this locks down: both FCFS phases on 2026-09-16 died 757ms
  // after their published start, on a "minted out" that OpenSea gave about
  // the PREVIOUS phase — we poll before our own stage opens, and OpenSea's
  // /mint takes no stage argument. Supply still remained.
  it("is NOT terminal when our stage has not opened yet", () => {
    expect(mintedOutIsTerminal({ nowMs: T - 500, fireTargetMs: T })).toBe(false);
    expect(mintedOutIsTerminal({ nowMs: T - 1, fireTargetMs: T })).toBe(false);
  });

  // Live 2026-09-16 21:30 projectcpu: the plan was killed at T+2s on a 422
  // about the GTD phase, and the collection went on to mint 14,774 more
  // tokens (10,517 -> 25,291 of 29,150). `now >= fireTarget` guarded the
  // wrong half of the window — OpenSea's clock trails ours by 343-1200ms.
  it("is NOT terminal inside the grace covering OpenSea's clock lag", () => {
    expect(mintedOutIsTerminal({ nowMs: T, fireTargetMs: T })).toBe(false);
    expect(mintedOutIsTerminal({ nowMs: T + 2_000, fireTargetMs: T })).toBe(false);
  });

  it("is terminal once the stage is open past the grace, with no supply reading", () => {
    expect(mintedOutIsTerminal({ nowMs: T + 5_000, fireTargetMs: T })).toBe(true);
    expect(mintedOutIsTerminal({ nowMs: T + 60_000, fireTargetMs: T })).toBe(true);
  });

  // The contract outranks both the message and the clock (playbook §4).
  it("is NOT terminal while the contract still has supply, however late", () => {
    expect(
      mintedOutIsTerminal({
        nowMs: T + 600_000,
        fireTargetMs: T,
        supply: { currentTotalSupply: 25_291n, maxSupply: 29_150n },
      }),
    ).toBe(false);
  });

  it("is terminal when the contract agrees the supply is gone", () => {
    expect(
      mintedOutIsTerminal({
        nowMs: T,
        fireTargetMs: T,
        supply: { currentTotalSupply: 29_150n, maxSupply: 29_150n },
      }),
    ).toBe(true);
  });

  it("trusts the provider when there is no known target to argue with", () => {
    expect(mintedOutIsTerminal({ nowMs: T, fireTargetMs: null })).toBe(true);
  });
});

describe("precheckAllowance", () => {
  const base = {
    requested: 3,
    cap: 3,
    minterNumMinted: 0n,
    currentTotalSupply: 100n,
    maxSupply: 29_150n,
  };

  // projectcpu 2026-09-16: the wallet spent its cumulative cap of 3 on the
  // 21:00 GTD, so the 21:30 FCFS plan was dead the moment the GTD receipt
  // landed. The fire path did not know, burst anyway, and then killed the
  // plan on a 422 about the GTD phase. This is the fact that was missing.
  it("is terminal when the cumulative cap is already spent", () => {
    expect(precheckAllowance({ ...base, minterNumMinted: 3n })).toEqual({
      verdict: "allowance_exhausted",
      cap: 3,
    });
  });

  it("sizes the request to the remaining allowance instead of failing it", () => {
    // cap 3, one already minted elsewhere -> ask for 2, not 3, not zero.
    expect(precheckAllowance({ ...base, minterNumMinted: 1n })).toEqual({
      verdict: "ok",
      quantity: 2,
    });
  });

  it("is terminal only when the contract itself is out of supply", () => {
    expect(precheckAllowance({ ...base, currentTotalSupply: 29_150n })).toEqual({
      verdict: "minted_out",
    });
    // 25,291 of 29,150 was the live state while OpenSea was answering
    // "Drop is fully minted out" about a different phase.
    expect(precheckAllowance({ ...base, currentTotalSupply: 25_291n })).toEqual({
      verdict: "ok",
      quantity: 3,
    });
  });

  it("clamps to remaining supply when the drop is nearly gone", () => {
    expect(precheckAllowance({ ...base, requested: 3, currentTotalSupply: 29_148n })).toEqual({
      verdict: "ok",
      quantity: 2,
    });
  });

  it("leaves the request whole when the cap is unknown", () => {
    expect(precheckAllowance({ ...base, cap: null, minterNumMinted: 99n })).toEqual({
      verdict: "ok",
      quantity: 3,
    });
  });

  it("treats maxSupply 0 as unbounded, not as minted out", () => {
    expect(precheckAllowance({ ...base, maxSupply: 0n })).toEqual({ verdict: "ok", quantity: 3 });
  });
});

describe("preBuildBackoffMs", () => {
  // The waste this bounds: an identical HTTP 422 every 30s for eight minutes
  // against a plan that could not succeed (projectcpu FCFS, 2026-09-16).
  it("doubles from one tick and caps at five minutes", () => {
    expect(preBuildBackoffMs(1)).toBe(30_000);
    expect(preBuildBackoffMs(2)).toBe(60_000);
    expect(preBuildBackoffMs(3)).toBe(120_000);
    expect(preBuildBackoffMs(4)).toBe(240_000);
    expect(preBuildBackoffMs(5)).toBe(300_000);
    expect(preBuildBackoffMs(50)).toBe(300_000);
  });

  it("never returns a negative or zero delay", () => {
    expect(preBuildBackoffMs(0)).toBe(30_000);
    expect(preBuildBackoffMs(-3)).toBe(30_000);
  });
});

import { describe, expect, it } from "vitest";
import { isPerWalletLimitError, isTerminalMintBuildError, mintedOutIsTerminal } from "./mint-tx.ts";

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

import { describe, expect, it } from "vitest";
import { isPerWalletLimitError, isTerminalMintBuildError } from "./mint-tx.ts";

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

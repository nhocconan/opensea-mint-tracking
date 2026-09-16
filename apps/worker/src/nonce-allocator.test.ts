import { beforeEach, describe, expect, it } from "vitest";
import { releaseNonce, reserveNonce, resetNonceReservations } from "./nonce-allocator.ts";

const WALLET_A = "0xAbCdEf0123456789ABCDEF0123456789ABCDEF01";
const WALLET_B = "0x1111111111111111111111111111111111111a";

beforeEach(() => {
  resetNonceReservations();
});

describe("reserveNonce", () => {
  it("gives two sibling plans on the same wallet, called back to back with the same rpc nonce, N then N+1", () => {
    // This is the defect the module exists for: an FCFS plan and a public
    // plan on one burner wallet both read pending nonce N independently and
    // both signed at N, so one mint silently never landed.
    const first = reserveNonce(WALLET_A, 5);
    const second = reserveNonce(WALLET_A, 5);
    expect(first).toBe(5);
    expect(second).toBe(6);
  });

  it("tracks two different wallets independently", () => {
    expect(reserveNonce(WALLET_A, 10)).toBe(10);
    expect(reserveNonce(WALLET_B, 3)).toBe(3);
    expect(reserveNonce(WALLET_A, 10)).toBe(11);
    expect(reserveNonce(WALLET_B, 3)).toBe(4);
  });

  it("lets the rpc nonce win when it is ahead of the reservation, never just +1", () => {
    expect(reserveNonce(WALLET_A, 5)).toBe(5);
    expect(reserveNonce(WALLET_A, 10)).toBe(10);
  });

  it("still honors a reservation exactly at the ttl boundary", () => {
    reserveNonce(WALLET_A, 5, 0);
    expect(reserveNonce(WALLET_A, 5, 60_000)).toBe(6);
  });

  it("ignores a reservation older than the ttl and returns the raw rpc nonce", () => {
    reserveNonce(WALLET_A, 5, 0);
    expect(reserveNonce(WALLET_A, 5, 60_001)).toBe(5);
  });

  it("matches wallet addresses case-insensitively, so checksummed and lowercase are one wallet", () => {
    const lower = WALLET_A.toLowerCase();
    expect(reserveNonce(WALLET_A, 5)).toBe(5);
    expect(reserveNonce(lower, 5)).toBe(6);
  });
});

describe("releaseNonce", () => {
  it("does not clear a live reservation when the released nonce does not match", () => {
    reserveNonce(WALLET_A, 5);
    releaseNonce(WALLET_A, 999);
    expect(reserveNonce(WALLET_A, 5)).toBe(6);
  });

  it("clears the reservation when the released nonce matches, so the next call returns the raw rpc nonce", () => {
    reserveNonce(WALLET_A, 5);
    releaseNonce(WALLET_A, 5);
    expect(reserveNonce(WALLET_A, 7)).toBe(7);
  });
});

describe("released nonces are reused, not skipped", () => {
  // The deadlock this prevents: plan A takes N, plan B takes N+1, A's
  // broadcast fails and B's is pending. Without a free list A's retry gets
  // N+2, nobody fills N, and B is stuck behind the gap forever.
  it("hands a released nonce back to the next caller instead of skipping past it", () => {
    const w = "0xAaAa000000000000000000000000000000000001";
    expect(reserveNonce(w, 5)).toBe(5);
    expect(reserveNonce(w, 5)).toBe(6);
    releaseNonce(w, 5);
    expect(reserveNonce(w, 5)).toBe(5);
  });

  it("does not replay a nonce the chain has already moved past", () => {
    const w = "0xAaAa000000000000000000000000000000000002";
    expect(reserveNonce(w, 5)).toBe(5);
    releaseNonce(w, 5);
    expect(reserveNonce(w, 9)).toBe(9);
  });

  it("keeps siblings distinct after a reuse", () => {
    const w = "0xAaAa000000000000000000000000000000000003";
    expect(reserveNonce(w, 1)).toBe(1);
    expect(reserveNonce(w, 1)).toBe(2);
    releaseNonce(w, 1);
    expect(reserveNonce(w, 1)).toBe(1);
    expect(reserveNonce(w, 1)).toBe(3);
  });
});

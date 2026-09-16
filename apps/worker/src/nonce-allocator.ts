/**
 * Per-wallet nonce reservation for the mint fire path.
 *
 * Every path that needed a nonce used to read `blockTag: "pending"`
 * independently — once per pre-sign candidate and once per fire. Two plans on
 * the SAME burner wallet (the ordinary case: an FCFS phase and a public phase
 * on one wallet) therefore both received pending nonce N while neither
 * transaction had been broadcast yet. Both signed at N, both broadcast, one
 * was accepted and the other was rejected as a duplicate/underpriced
 * replacement — so one of the two mints silently never landed, and the losing
 * plan burned its place in the burst re-signing.
 *
 * The allocator hands out N, N+1, … per wallet within a short window while
 * still letting the chain be the authority: the reservation can only ever
 * push a nonce FORWARD of what the RPC reports, never behind it, so as soon
 * as the RPC catches up the reservation stops mattering.
 */

interface Reservation {
  /** Highest nonce handed out for this wallet so far. */
  readonly nonce: number;
  /** When it was handed out, for expiry. */
  readonly atMs: number;
}

/**
 * Reservations older than this are ignored. Long enough to cover one fire
 * window (two plans on one wallet firing at the same instant), short enough
 * that a stale entry cannot strand a wallet behind a nonce gap across
 * unrelated mints.
 */
const RESERVATION_TTL_MS = 60_000;

const reservations = new Map<string, Reservation>();

/**
 * Nonces handed out and then given back because the transaction never
 * reached the wire.
 *
 * Without this, two plans on one wallet deadlock each other. Plan A takes N,
 * plan B takes N+1. A's broadcast fails (a saturated RPC — the 21:00 GTD),
 * B's succeeds and sits pending at N+1. A retries: the RPC still reports
 * pending nonce N, but the reservation now says N+1, so `max(N, N+2)` hands
 * A **N+2**. Nobody ever uses N, so B is stuck behind a permanent gap and A
 * is stuck behind B. Both mints lost. Releasing into a free list lets A take
 * N back and fill the hole.
 */
const freed = new Map<string, number[]>();

function key(walletAddress: string): string {
  return walletAddress.toLowerCase();
}

/**
 * Given the nonce the RPC currently reports as pending for this wallet,
 * return the nonce this caller should actually sign with, and record it.
 *
 * `rpcNonce` always wins when it is ahead — the chain has moved on and any
 * reservation below it is meaningless. Otherwise the caller gets one past the
 * last reservation, so siblings in the same instant get distinct nonces.
 */
export function reserveNonce(walletAddress: string, rpcNonce: number, nowMs = Date.now()): number {
  const k = key(walletAddress);
  const held = reservations.get(k);
  const usable = held !== undefined && nowMs - held.atMs <= RESERVATION_TTL_MS;

  // A returned nonce is reused before any new one is minted, so a failed
  // sibling cannot leave a permanent hole. Anything the chain has already
  // moved past is dropped rather than replayed.
  const pool = (freed.get(k) ?? []).filter((n) => n >= rpcNonce).sort((a, b) => a - b);
  const reuse = pool.shift();
  if (reuse !== undefined) {
    freed.set(k, pool);
    if (!usable || reuse > (held?.nonce ?? -1)) {
      reservations.set(k, { nonce: reuse, atMs: nowMs });
    }
    return reuse;
  }
  freed.set(k, pool);

  const next = usable ? Math.max(rpcNonce, held.nonce + 1) : rpcNonce;
  reservations.set(k, { nonce: next, atMs: nowMs });
  return next;
}

/**
 * Drop a wallet's reservation. Called when a signed transaction was NOT
 * broadcast after all, so the reserved nonce is not actually consumed and the
 * next caller must not skip past it and open a gap that strands the wallet.
 */
export function releaseNonce(walletAddress: string, nonce: number): void {
  const k = key(walletAddress);
  const held = reservations.get(k);
  if (held !== undefined && held.nonce === nonce) {
    reservations.delete(k);
  }
  // Return it to the pool even when a SIBLING has since reserved a higher
  // nonce — that is precisely the case the pool exists for. But only a nonce
  // that was plausibly handed out: releasing an arbitrary number must never
  // inject it into the sequence.
  const highest = held?.nonce ?? -1;
  if (nonce > highest) {
    return;
  }
  const pool = freed.get(k) ?? [];
  if (!pool.includes(nonce)) {
    pool.push(nonce);
    freed.set(k, pool);
  }
}

/** Test seam. */
export function resetNonceReservations(): void {
  reservations.clear();
  freed.clear();
}

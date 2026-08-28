import { mintSpendCeilingWei } from "./stage-id.ts";

/**
 * Auto-mint policy (owner ask 2026-08-28): with a funded burner wallet,
 * automatically plan + arm mints for drops that match a policy — by default
 * FREE, PUBLIC stages — gated by the Grok X-search scam signal when one
 * exists. Pure decision logic here; the worker (apps/worker/auto-mint.ts)
 * supplies candidates + persisted state and does the arming.
 *
 * Safety model: the policy can only ever create plans on MANAGED wallets the
 * operator explicitly listed, the fire path is still gated by
 * LIVE_EXECUTION_ENABLED, every plan carries a per-plan ceiling
 * (price + OpenSea mint-fee allowance per token, see `mintSpendCeilingWei`), and daily
 * caps bound the blast radius of a mis-config.
 */
export const AUTO_MINT_POLICY_SETTING_KEY = "auto_mint_policy";

export interface AutoMintPolicy {
  readonly enabled: boolean;
  /** Managed wallet ids the policy may plan on. */
  readonly walletIds: readonly string[];
  /** Max mint price per token, wei, decimal string. "0" = free mints only. */
  readonly maxPriceWei: string;
  /** Only public stages (a burner is never allowlisted). */
  readonly publicOnly: boolean;
  /** Skip a drop whose latest Grok risk score exceeds this (0-100). */
  readonly maxRiskScore: number;
  /** If true, drops with NO risk signal yet are skipped (strict mode). */
  readonly requireRiskSignal: boolean;
  /** Plan stages opening within this many hours (or already live). */
  readonly lookaheadHours: number;
  /** Max executed auto-mints per wallet per rolling 24h. */
  readonly maxPerWalletPerDay: number;
  /** Tokens per plan. */
  readonly quantity: number;
  /** Quality gate: only drops OpenSea itself lists in its curated /drops
   *  feeds (featured/upcoming/recently_minted), not ones found solely by
   *  the chain-wide collection sweep. Strong, free signal — independent of
   *  Grok (owner ask: don't mint junk like "an X account with 1 follower"). */
  readonly requireCuratedListing: boolean;
  /** Skip when the latest Grok hype score is below this (0 = off; a drop
   *  with NO hype signal is not blocked by this gate). */
  readonly minHypeScore: number;
  /** For stages already LIVE: require at least this many unique minters in
   *  the last hour (0 = off). Demand proof for already-open free mints. */
  readonly minUniqueMintersLive: number;
  /** Who enabled it — plans are armed on their behalf (audit + armedBy). */
  readonly ownerUserId: string | null;
}

export const DEFAULT_AUTO_MINT_POLICY: AutoMintPolicy = {
  enabled: false,
  walletIds: [],
  maxPriceWei: "0",
  publicOnly: true,
  maxRiskScore: 40,
  requireRiskSignal: false,
  lookaheadHours: 24,
  maxPerWalletPerDay: 20,
  quantity: 1,
  requireCuratedListing: true,
  minHypeScore: 0,
  minUniqueMintersLive: 0,
  ownerUserId: null,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}
function int(v: unknown, d: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
  if (!Number.isFinite(n)) {
    return d;
  }
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Parse + default + clamp a stored/submitted policy. Never throws: a
 * malformed field falls back to its default so a bad edit can't brick the
 * planner (which is disabled by default anyway).
 */
export function parseAutoMintPolicy(input: unknown): AutoMintPolicy {
  const o = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const walletIds = Array.isArray(o.walletIds)
    ? o.walletIds.filter((w): w is string => typeof w === "string" && UUID.test(w))
    : [];
  const maxPriceWei =
    typeof o.maxPriceWei === "string" && /^[0-9]+$/.test(o.maxPriceWei) ? o.maxPriceWei : "0";
  const ownerUserId =
    typeof o.ownerUserId === "string" && o.ownerUserId.length > 0 ? o.ownerUserId : null;
  const d = DEFAULT_AUTO_MINT_POLICY;
  return {
    enabled: bool(o.enabled, d.enabled),
    walletIds,
    maxPriceWei,
    publicOnly: bool(o.publicOnly, d.publicOnly),
    maxRiskScore: int(o.maxRiskScore, d.maxRiskScore, 0, 100),
    requireRiskSignal: bool(o.requireRiskSignal, d.requireRiskSignal),
    lookaheadHours: int(o.lookaheadHours, d.lookaheadHours, 1, 168),
    maxPerWalletPerDay: int(o.maxPerWalletPerDay, d.maxPerWalletPerDay, 1, 500),
    quantity: int(o.quantity, d.quantity, 1, 10),
    requireCuratedListing: bool(o.requireCuratedListing, d.requireCuratedListing),
    minHypeScore: int(o.minHypeScore, d.minHypeScore, 0, 100),
    minUniqueMintersLive: int(o.minUniqueMintersLive, d.minUniqueMintersLive, 0, 10_000),
    ownerUserId,
  };
}

export interface AutoMintCandidate {
  readonly projectId: string;
  readonly projectName: string;
  readonly stageId: string;
  readonly stageKind: string;
  readonly priceWei: string | null;
  readonly startsAtMs: number;
  readonly endsAtMs: number | null;
  readonly paused: boolean;
  /** Latest Grok risk score for the project, null if never scanned. */
  readonly riskScore: number | null;
  /** Latest Grok hype score, null if never scanned. */
  readonly hypeScore: number | null;
  /** Appeared in an OpenSea curated /drops feed (not just the collection sweep). */
  readonly curated: boolean;
  /** Unique minter addresses in the last hour (on-chain radar). */
  readonly uniqueMinters1h: number;
}

export type AutoMintDecision =
  | { readonly plan: true; readonly ceilingWei: string; readonly armMinutes: number }
  | { readonly plan: false; readonly reason: string };

/** Pure per-(policy, candidate) decision. Wallet-level caps are checked by the caller. */
/** How long a live stage may be open before we demand visible minting. */
export const LIVE_DEMAND_GRACE_MS = 15 * 60_000;

function formatOpenFor(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 120) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function decideAutoMint(
  policy: AutoMintPolicy,
  c: AutoMintCandidate,
  nowMs: number,
): AutoMintDecision {
  if (!policy.enabled) {
    return { plan: false, reason: "policy disabled" };
  }
  if (c.paused) {
    return { plan: false, reason: "stage paused" };
  }
  if (c.endsAtMs !== null && c.endsAtMs <= nowMs) {
    return { plan: false, reason: "stage ended" };
  }
  if (c.startsAtMs > nowMs + policy.lookaheadHours * 3_600_000) {
    return { plan: false, reason: "beyond lookahead" };
  }
  if (policy.publicOnly && c.stageKind !== "public") {
    return { plan: false, reason: `stage is ${c.stageKind}, not public` };
  }
  const price = BigInt(c.priceWei ?? "0");
  if (price > BigInt(policy.maxPriceWei)) {
    return { plan: false, reason: `price ${price} > max ${policy.maxPriceWei}` };
  }
  if (c.riskScore === null) {
    if (policy.requireRiskSignal) {
      return { plan: false, reason: "no risk signal yet (strict mode)" };
    }
  } else if (c.riskScore > policy.maxRiskScore) {
    return { plan: false, reason: `risk ${c.riskScore} > max ${policy.maxRiskScore}` };
  }
  if (policy.requireCuratedListing && !c.curated) {
    return { plan: false, reason: "not in an OpenSea curated drops feed" };
  }
  if (policy.minHypeScore > 0 && c.hypeScore !== null && c.hypeScore < policy.minHypeScore) {
    return { plan: false, reason: `hype ${c.hypeScore} < min ${policy.minHypeScore}` };
  }
  // Demand gates apply only once a live stage has been open long enough for
  // demand to show: a stage that opened seconds ago legitimately has zero
  // minters (that is the moment to fire). A stage open for hours with
  // nobody minting is a dead drop — never worth gas, whatever the policy.
  const isLive = c.startsAtMs <= nowMs;
  const openForMs = nowMs - c.startsAtMs;
  if (isLive && openForMs > LIVE_DEMAND_GRACE_MS) {
    const openFor = formatOpenFor(openForMs);
    if (c.uniqueMinters1h === 0) {
      return { plan: false, reason: `open ${openFor} with 0 minters in the last hour (dead drop)` };
    }
    if (policy.minUniqueMintersLive > 0 && c.uniqueMinters1h < policy.minUniqueMintersLive) {
      return {
        plan: false,
        reason: `open ${openFor}, only ${c.uniqueMinters1h} unique minters/1h < min ${policy.minUniqueMintersLive}`,
      };
    }
  }
  // Price × quantity plus OpenSea's per-token mint fee allowance: a "free"
  // stage still costs the SeaDrop fee (~0.00008 ETH), so a 1-wei ceiling
  // refused every fire (found live 2026-08-28).
  const ceilingWei = mintSpendCeilingWei(price.toString(10), policy.quantity);
  // Arm until the stage ends (or 24h), never less than a minute; the hot
  // loop / pre-sign path takes it from there.
  const endMs = c.endsAtMs ?? nowMs + 24 * 3_600_000;
  const armMinutes = Math.max(1, Math.min(24 * 60, Math.ceil((endMs - nowMs) / 60_000)));
  return { plan: true, ceilingWei, armMinutes };
}

/**
 * `preflight-mint` — the single "am I ready to mint in 2 hours?" view.
 *
 * One verdict table per armed/draft mint plan for a project slug (or one plan
 * id), gathering the readiness signals that are otherwise scattered across
 * Admin → Special mints, the wallets page and the RPC health widget: the arm
 * window vs the fire instant, the stage's own state, native + ERC-20 funding,
 * the pending nonce (and wallet collisions), every broadcast RPC's latency and
 * the stored chain clock offset.
 *
 * READ-ONLY, absolutely: it issues SELECTs and `eth_call`-class reads only —
 * no transaction, no broadcast, no DB write, no state change of any kind. It
 * never reads, decrypts, prints or logs key material; a wallet's signing key
 * is reported as a BOOLEAN ("key: yes/no") and nothing more.
 *
 * Unlike the web arm-time funding gate (apps/web/src/lib/funding.ts), which
 * fails OPEN on an unreachable RPC, an unreadable balance here is a BLOCKER:
 * this tool exists to say "verified", and "could not check" is never that.
 *
 * Usage:
 *   pnpm --filter @hoodmint/worker exec tsx ../../scripts/preflight-mint.ts <slug|plan-id>
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { mintRpcUrls } from "../apps/worker/src/mint-rpc.ts";
import { CHAIN_CLOCK_OFFSET_MEASURED_AT_SETTING_KEY } from "../apps/worker/src/workers/clock-calibration.ts";
import {
  resolveBestRpcUrl,
  resolveBroadcastRpcUrls,
} from "../apps/worker/src/workers/rpc-health.ts";
import { loadEnv } from "../packages/config/src/index.ts";
import {
  assessMintFunding,
  CHAIN_CLOCK_OFFSET_SETTING_KEY,
  coerceDate,
  computeFirePhase,
  formatDateTimeGmt7,
  formatUnitsShort,
  isNativeCurrency,
  mintSpendCeilingWei,
} from "../packages/core/src/index.ts";
import { createDb, dbClient, getSetting, sql, unwrapRows } from "../packages/db/src/index.ts";
import { fetchErc20Funding, fetchNativeBalance } from "../packages/providers/src/chain/balance.ts";
import { fetchFeeContext } from "../packages/providers/src/chain/broadcast.ts";
import { getGasSnapshot } from "../packages/providers/src/chain/gas.ts";
import { SEADROP_ADDRESS } from "../packages/providers/src/chain/seadrop.ts";

/* ── Output primitives ───────────────────────────────────────────────────── */

type Level = "OK" | "WARN" | "BLOCKER";

interface CheckLine {
  readonly level: Level;
  readonly label: string;
  readonly detail: string;
}

const MARKER_WIDTH = 10;
const LABEL_WIDTH = 16;

function marker(level: Level): string {
  return `[${level}]`.padEnd(MARKER_WIDTH, " ");
}

function printCheck(line: CheckLine): void {
  console.log(`  ${marker(line.level)}${line.label.padEnd(LABEL_WIDTH, " ")}${line.detail}`);
}

function worst(lines: readonly CheckLine[]): Level {
  if (lines.some((l) => l.level === "BLOCKER")) {
    return "BLOCKER";
  }
  return lines.some((l) => l.level === "WARN") ? "WARN" : "OK";
}

/** Human-sized address for a dense table; never truncates anything but an address. */
function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  if (abs < 1000) {
    return `${sign}${abs} ms`;
  }
  const seconds = Math.floor(abs / 1000);
  if (seconds < 60) {
    return `${sign}${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${sign}${minutes}m ${seconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${sign}${hours}h ${minutes % 60}m`;
}

/** Wei → "0.0004 ETH (400000000000000 wei)". bigint only, never a float. */
function weiWithRaw(value: bigint, symbol = "ETH", decimals = 18): string {
  return `${formatUnitsShort(value, decimals)} ${symbol} (${value.toString(10)} wei)`;
}

/* ── Row shape (raw SQL: one query, everything the table needs) ──────────── */

interface PlanRow {
  readonly plan_id: string;
  readonly project_id: string;
  readonly status: string;
  readonly quantity: number;
  readonly per_plan_ceiling_wei: string;
  readonly fire_at: string | Date | null;
  readonly armed_at: string | Date | null;
  readonly armed_until: string | Date | null;
  readonly cached_tx: { to: string; valueWei: string } | null;
  readonly presigned_at: string | Date | null;
  readonly wallet_id: string;
  readonly wallet_address: string;
  readonly wallet_label: string | null;
  readonly wallet_enabled: boolean;
  /** Boolean ONLY — the sealed key blob is never selected, printed or read. */
  readonly has_signing_key: boolean;
  readonly project_slug: string | null;
  readonly project_name: string;
  readonly chain_id: number;
  readonly stage_id: string | null;
  readonly stage_label: string | null;
  readonly stage_kind: string | null;
  readonly stage_paused: boolean | null;
  readonly stage_starts_at: string | Date | null;
  readonly stage_ends_at: string | Date | null;
  readonly max_per_wallet: number | null;
  readonly stage_price_wei: string | null;
  readonly stage_currency: string | null;
}

/**
 * Every armed/draft plan on a wallet in scope — including ones the operator
 * did NOT ask about. A `--plan` run must still see the sibling that is going
 * to take the same nonce, so collisions are looked up per WALLET, never only
 * within the rows being printed.
 */
interface SiblingPlan {
  readonly planId: string;
  readonly walletId: string;
  readonly fireTargetMs: number | null;
  /** Needed to reason about the CUMULATIVE per-wallet cap across plans. */
  readonly quantity: number;
  readonly projectId: string;
}

interface WalletFacts {
  readonly nonce: number | null;
  readonly maxFeePerGasWei: bigint | null;
  readonly nativeBalanceWei: bigint | null;
  readonly error: string | null;
}

interface RpcProbe {
  readonly url: string;
  readonly latencyMs: number | null;
  readonly error: string | null;
}

/** RPC budget for this tool. Deliberately far above the fire path's 800ms. */
const PREFLIGHT_RPC_TIMEOUT_MS = 8_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(): void {
  console.log(`preflight-mint — one-screen readiness verdict for an imminent mint.

  Usage:
    pnpm --filter @hoodmint/worker exec tsx ../../scripts/preflight-mint.ts <slug|plan-id>
    pnpm --filter @hoodmint/worker exec tsx ../../scripts/preflight-mint.ts --slug hoodie-birds
    pnpm --filter @hoodmint/worker exec tsx ../../scripts/preflight-mint.ts --plan <uuid>

  Arguments:
    <slug|plan-id>   OpenSea collection slug, or a mint plan UUID.
    --slug <slug>    Force the argument to be read as a project slug.
    --plan <uuid>    Force the argument to be read as a mint plan id.
    --help, -h       This text.

  Prints one block per armed/draft mint plan: plan state, arm window vs fire
  instant, stage, native funding, ERC-20 balance + allowance, pending nonce and
  wallet collisions, plus shared RPC-health and chain-clock sections.

  Read-only: SELECTs and chain reads only. Never signs, broadcasts or writes.
  Exit code 0 only when nothing is a BLOCKER.`);
}

/**
 * `loadEnv` reads `process.env` only, and the repo keeps its values in the
 * workspace-root `.env` — so find that root by walking up from the cwd (the
 * operator runs this from the repo root or, via `pnpm --filter`, from
 * apps/worker) and load it. Values are consumed by the config parser and are
 * never printed: nothing in this file ever echoes an env value.
 */
function loadRepoEnvFile(): void {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      try {
        process.loadEnvFile(join(dir, ".env"));
      } catch {
        // No .env here: loadEnv reports exactly which variables are missing.
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return;
    }
    dir = parent;
  }
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline !== undefined) {
    return inline.slice(name.length + 1);
  }
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/* ── Chain-facing reads (every failure is surfaced, never swallowed) ─────── */

/**
 * viem spells an RPC failure across a dozen lines (URL, request body, version
 * banner). A row in this table is one line, so flatten and clip: the operator
 * needs "which endpoint, what went wrong", not the transport's essay.
 */
function oneLine(error: unknown, fallback: string, max = 140): string {
  const raw = error instanceof Error ? error.message : fallback;
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function probeRpc(url: string): Promise<RpcProbe> {
  const started = Date.now();
  try {
    const snapshot = await getGasSnapshot(url);
    return { url, latencyMs: snapshot.latencyMs, error: null };
  } catch (error) {
    return { url, latencyMs: Date.now() - started, error: oneLine(error, "probe failed") };
  }
}

async function readWalletFacts(rpcUrl: string, address: string): Promise<WalletFacts> {
  try {
    const [balance, fees] = await Promise.all([
      fetchNativeBalance(rpcUrl, address),
      // The fire path's 800ms default exists because the mint window is 4s
      // wide; a pre-flight run hours earlier can afford to wait for a real
      // answer rather than report a healthy endpoint as unverified.
      fetchFeeContext(rpcUrl, address, { timeoutMs: PREFLIGHT_RPC_TIMEOUT_MS }),
    ]);
    return {
      nonce: fees.nonce,
      maxFeePerGasWei: BigInt(fees.maxFeePerGasWei),
      nativeBalanceWei: balance,
      error: null,
    };
  } catch (error) {
    return {
      nonce: null,
      maxFeePerGasWei: null,
      nativeBalanceWei: null,
      error: oneLine(error, "read failed"),
    };
  }
}

/* ── Per-plan checks ─────────────────────────────────────────────────────── */

function fireTargetMs(row: PlanRow): number | null {
  const source = row.fire_at ?? row.stage_starts_at;
  if (source === null) {
    return null;
  }
  const at = coerceDate(source).getTime();
  return Number.isNaN(at) ? null : at;
}

function checkState(row: PlanRow): CheckLine {
  const ceiling = BigInt(row.per_plan_ceiling_wei);
  const detail =
    `status=${row.status} · qty=${row.quantity} · ceiling ${weiWithRaw(ceiling)}` +
    ` · armed_until ${row.armed_until === null ? "not set" : formatDateTimeGmt7(row.armed_until)}`;
  if (row.status === "draft") {
    return {
      level: "WARN",
      label: "plan state",
      detail: `${detail} · DRAFT: arm it before the window opens`,
    };
  }
  return { level: "OK", label: "plan state", detail };
}

/** The loudest check in the tool: an arm window that closes before the fire
 *  instant means the plan can never fire, however healthy everything else is. */
function checkArmWindow(row: PlanRow, nowMs: number): CheckLine[] {
  const lines: CheckLine[] = [];
  const target = fireTargetMs(row);
  const armedUntil = row.armed_until === null ? null : coerceDate(row.armed_until).getTime();
  const source = row.fire_at !== null ? "fire_at" : "stage.starts_at";

  if (target === null) {
    lines.push({
      level: "BLOCKER",
      label: "fire instant",
      detail: "no fire_at and no linked stage — nothing for the hot loop to fire on",
    });
    return lines;
  }

  const targetText = `${formatDateTimeGmt7(new Date(target))} (${source})`;
  const until = target - nowMs;
  lines.push({
    level: until < 0 ? "WARN" : "OK",
    label: "fire instant",
    detail:
      until < 0
        ? `${targetText} — already passed ${formatDuration(-until)} ago`
        : `${targetText} — T-${formatDuration(until)}`,
  });

  if (armedUntil === null) {
    lines.push({
      level: row.status === "armed" ? "BLOCKER" : "WARN",
      label: "arm window",
      detail: "armed_until is not set — no arm window exists",
    });
    return lines;
  }

  if (armedUntil < target) {
    lines.push({
      level: "BLOCKER",
      label: "arm window",
      detail:
        `armed_until ${formatDateTimeGmt7(new Date(armedUntil))} is ` +
        `${formatDuration(target - armedUntil)} BEFORE the fire instant — ` +
        "THIS PLAN CAN NEVER FIRE; re-arm with a window that covers it",
    });
    return lines;
  }

  if (row.status === "armed" && armedUntil < nowMs) {
    lines.push({
      level: "BLOCKER",
      label: "arm window",
      detail: `arm expired ${formatDuration(nowMs - armedUntil)} ago — re-arm the plan`,
    });
    return lines;
  }

  lines.push({
    level: "OK",
    label: "arm window",
    detail:
      `armed_until ${formatDateTimeGmt7(new Date(armedUntil))} — ` +
      `covers the fire instant by ${formatDuration(armedUntil - target)}`,
  });
  return lines;
}

function checkStage(row: PlanRow): CheckLine[] {
  if (row.stage_id === null) {
    return [
      {
        level: "WARN",
        label: "stage",
        detail: "no linked stage (fire_at-only plan) — price, cap and pause state unknown",
      },
    ];
  }
  const lines: CheckLine[] = [];
  const price = row.stage_price_wei;
  const currency = row.stage_currency;
  const priceText =
    price === null
      ? "price unpublished"
      : isNativeCurrency(currency)
        ? weiWithRaw(BigInt(price))
        : `${price} (raw units of ${currency ?? "token"})`;
  lines.push({
    level: row.stage_paused === true ? "BLOCKER" : "OK",
    label: "stage",
    detail:
      `${row.stage_label ?? "?"} · kind=${row.stage_kind ?? "?"} · ${priceText}` +
      (row.stage_paused === true ? " · PAUSED/SUPERSEDED — this stage will not mint" : ""),
  });
  lines.push({
    level: "OK",
    label: "stage window",
    detail: `starts ${formatDateTimeGmt7(row.stage_starts_at)} · ends ${formatDateTimeGmt7(row.stage_ends_at)}`,
  });

  const target = fireTargetMs(row);
  if (row.stage_ends_at !== null && target !== null) {
    const endsAt = coerceDate(row.stage_ends_at).getTime();
    if (endsAt < target) {
      lines.push({
        level: "BLOCKER",
        label: "stage window",
        detail: `stage ends ${formatDuration(target - endsAt)} BEFORE the fire instant`,
      });
    }
  }

  const cap = row.max_per_wallet;
  if (cap === null) {
    lines.push({ level: "WARN", label: "per-wallet cap", detail: "max_per_wallet unpublished" });
  } else if (row.quantity > cap) {
    lines.push({
      level: "BLOCKER",
      label: "per-wallet cap",
      detail: `quantity ${row.quantity} > max_per_wallet ${cap} — the mint call will revert`,
    });
  } else {
    lines.push({
      level: "OK",
      label: "per-wallet cap",
      detail: `quantity ${row.quantity} ≤ max_per_wallet ${cap}`,
    });
  }
  return lines;
}

/** Native value the fire will send: stage price × qty + OpenSea's per-token
 *  SeaDrop fee, or the per-plan ceiling when no stage is linked. Mirrors the
 *  worker presign gate so this tool and the fire path agree on "enough". */
function plannedValueWei(row: PlanRow): bigint {
  if (row.stage_id === null) {
    return BigInt(row.per_plan_ceiling_wei);
  }
  const nativePriced = isNativeCurrency(row.stage_currency);
  return BigInt(mintSpendCeilingWei(nativePriced ? row.stage_price_wei : null, row.quantity));
}

function checkNativeFunding(
  row: PlanRow,
  facts: WalletFacts,
  gasLimit: bigint,
  rpcUsable: boolean,
): CheckLine {
  if (!rpcUsable || facts.nativeBalanceWei === null || facts.maxFeePerGasWei === null) {
    return {
      level: "BLOCKER",
      label: "native funds",
      detail: `NOT VERIFIED — ${facts.error ?? "no reachable RPC"} (never treat unchecked as funded)`,
    };
  }
  const valueWei = plannedValueWei(row);
  const verdict = assessMintFunding({
    nativeBalanceWei: facts.nativeBalanceWei,
    valueWei,
    gasLimit,
    maxFeePerGasWei: facts.maxFeePerGasWei,
  });
  if (!verdict.ok) {
    return { level: "BLOCKER", label: "native funds", detail: verdict.message };
  }
  return {
    level: "OK",
    label: "native funds",
    detail:
      `balance ${weiWithRaw(facts.nativeBalanceWei)} ≥ required ` +
      `${weiWithRaw(verdict.requiredNativeWei)} ` +
      `[value ${formatUnitsShort(valueWei)} + gas ${gasLimit.toString(10)} × ` +
      `${formatUnitsShort(facts.maxFeePerGasWei, 9)} gwei]`,
  };
}

/**
 * ERC-20 priced stage: balance AND allowance toward the mint contract. There
 * is no approve() anywhere in this repository, so an insufficient allowance is
 * terminal for an unattended fire — the operator must approve the named
 * spender from the wallet themselves.
 */
async function checkErc20(
  row: PlanRow,
  rpcUrl: string | null,
  spender: string,
  spenderSource: string,
): Promise<CheckLine[]> {
  const currency = row.stage_currency;
  if (currency === null || isNativeCurrency(currency)) {
    return [];
  }
  if (rpcUrl === null) {
    return [
      {
        level: "BLOCKER",
        label: "erc-20",
        detail: `token ${currency}: NOT VERIFIED — no reachable RPC`,
      },
    ];
  }
  const price = row.stage_price_wei;
  if (price === null || !/^[0-9]+$/.test(price)) {
    return [
      {
        level: "BLOCKER",
        label: "erc-20",
        detail: `token ${currency}: stage price unpublished — required amount unknowable`,
      },
    ];
  }
  const required = BigInt(price) * BigInt(Math.max(1, row.quantity));
  let funding: Awaited<ReturnType<typeof fetchErc20Funding>>;
  try {
    funding = await fetchErc20Funding(rpcUrl, currency, row.wallet_address, spender);
  } catch (error) {
    return [
      {
        level: "BLOCKER",
        label: "erc-20",
        detail: `token ${currency}: NOT VERIFIED — ${oneLine(error, "read failed")}`,
      },
    ];
  }
  const { balance, allowance, symbol, decimals } = funding;
  const lines: CheckLine[] = [];
  lines.push({
    level: balance < required ? "BLOCKER" : "OK",
    label: "erc-20 balance",
    detail:
      `${formatUnitsShort(balance, decimals)} ${symbol} vs required ` +
      `${formatUnitsShort(required, decimals)} ${symbol} (token ${currency})` +
      (balance < required
        ? ` — short ${formatUnitsShort(required - balance, decimals)} ${symbol}`
        : ""),
  });
  if (allowance === undefined) {
    lines.push({
      level: "BLOCKER",
      label: "erc-20 allow",
      detail: `allowance unreadable for spender ${spender} — cannot prove the mint can pay`,
    });
    return lines;
  }
  if (allowance < required) {
    lines.push({
      level: "BLOCKER",
      label: "erc-20 allow",
      detail:
        `allowance ${formatUnitsShort(allowance, decimals)} ${symbol} < required ` +
        `${formatUnitsShort(required, decimals)} ${symbol}. No approve() exists anywhere in this ` +
        `repo — approve ${spender} (${spenderSource}) for ${symbol} ${currency} from ` +
        `${row.wallet_address} by hand, or this plan CANNOT mint`,
    });
    return lines;
  }
  lines.push({
    level: "OK",
    label: "erc-20 allow",
    detail: `${formatUnitsShort(allowance, decimals)} ${symbol} approved to ${spender} (${spenderSource})`,
  });
  return lines;
}

function checkNonce(
  row: PlanRow,
  facts: WalletFacts,
  siblings: readonly SiblingPlan[],
  rpcUsable: boolean,
): CheckLine[] {
  const lines: CheckLine[] = [];
  lines.push(
    rpcUsable && facts.nonce !== null
      ? {
          level: "OK",
          label: "nonce",
          detail: `pending nonce ${facts.nonce} for ${row.wallet_address}`,
        }
      : {
          level: "BLOCKER",
          label: "nonce",
          detail: `pending nonce NOT VERIFIED — ${facts.error ?? "no reachable RPC"}`,
        },
  );
  lines.push({
    level: row.has_signing_key ? "OK" : "WARN",
    label: "signing key",
    detail: row.has_signing_key
      ? "a managed signing key EXISTS for this wallet (value never read)"
      : "no managed signing key — this plan needs a human browser-wallet signature",
  });
  if (!row.wallet_enabled) {
    lines.push({
      level: "BLOCKER",
      label: "wallet",
      detail: "wallet is disabled — it will not fire",
    });
  }

  const others = siblings.filter((p) => p.walletId === row.wallet_id && p.planId !== row.plan_id);
  if (others.length === 0) {
    return lines;
  }
  const target = fireTargetMs(row);
  const collidingIds: string[] = [];
  const otherIds: string[] = [];
  for (const other of others) {
    const otherTarget = other.fireTargetMs;
    if (target !== null && otherTarget !== null && Math.abs(otherTarget - target) <= 60_000) {
      collidingIds.push(shortId(other.planId));
    } else {
      otherIds.push(shortId(other.planId));
    }
  }
  if (collidingIds.length > 0) {
    lines.push({
      level: "WARN",
      label: "wallet share",
      detail:
        `plan(s) ${collidingIds.join(", ")} fire from the SAME wallet within 60s — ` +
        "they will be given consecutive nonces, so the second lands one slot behind the first",
    });
  }
  if (otherIds.length > 0) {
    const cap = row.max_per_wallet === null ? null : Number(row.max_per_wallet);
    const combined = Number(row.quantity) + others.reduce((sum, o) => sum + (o.quantity ?? 0), 0);
    // max_total_mintable_by_wallet is cumulative across every stage of the
    // drop, so two plans on one wallet are not additive: whichever fires
    // first consumes the allowance and the rest can only be refused. Saying
    // "also use this wallet" without saying that is useless to the operator.
    const cumulative =
      cap !== null && combined > cap
        ? ` — combined quantity ${combined} exceeds the cumulative per-wallet cap ${cap}, so only the EARLIEST plan can succeed; the rest are backups that will be refused if it does`
        : "";
    lines.push({
      level: "WARN",
      label: "wallet share",
      detail: `plan(s) ${otherIds.join(", ")} also use this wallet${cumulative}`,
    });
  }
  return lines;
}

function checkFirePhase(
  row: PlanRow,
  nowMs: number,
  offsetMs: number,
  knobs: FireKnobs,
): CheckLine[] {
  const target = fireTargetMs(row);
  if (target === null) {
    return [];
  }
  const phase = computeFirePhase({
    stageStartChainMs: target,
    clockOffsetMs: offsetMs,
    localNowMs: nowMs,
    hotWindowMs: knobs.hotWindowMs,
    leadMs: knobs.leadMs,
    continueForMs: knobs.continueForMs,
  });
  const detail =
    phase.phase === "waiting"
      ? `waiting — hot loop starts in ${formatDuration(phase.msUntilHotWindow)}`
      : phase.phase === "hot"
        ? `HOT — fires in ${formatDuration(phase.msUntilFire)}`
        : phase.phase === "fire"
          ? `FIRING NOW — ${formatDuration(phase.msSinceFireTarget)} past the fire target`
          : "EXPIRED — the fire + continue window has already closed";
  return [{ level: phase.phase === "expired" ? "WARN" : "OK", label: "fire phase", detail }];
}

interface FireKnobs {
  readonly hotWindowMs: number;
  readonly leadMs: number;
  readonly continueForMs: number;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    usage();
    process.exitCode = args.length === 0 ? 1 : 0;
    return;
  }

  const slugFlag = readFlag(args, "--slug");
  const planFlag = readFlag(args, "--plan");
  const positional = args.find((a) => !a.startsWith("--") && a !== slugFlag && a !== planFlag);
  const planId =
    planFlag ?? (positional !== undefined && UUID_RE.test(positional) ? positional : undefined);
  const slug = slugFlag ?? (planId === undefined ? positional : undefined);
  if (planId === undefined && (slug === undefined || slug === "")) {
    usage();
    process.exitCode = 1;
    return;
  }

  // `loadEnv` reads process.env only; the repo keeps its values in ./.env, so
  // load that when the shell has not already exported them. Values are used,
  // never printed.
  if (process.env.DATABASE_URL === undefined) {
    loadRepoEnvFile();
  }
  const config = loadEnv();
  const db = createDb(config.DATABASE_URL, { max: 2, applicationName: "hoodmint-preflight" });

  try {
    await run(db, config, { planId, slug });
  } finally {
    await dbClient(db).end({ timeout: 5 });
  }
}

async function run(
  db: ReturnType<typeof createDb>,
  config: ReturnType<typeof loadEnv>,
  target: { planId: string | undefined; slug: string | undefined },
): Promise<void> {
  const nowMs = Date.now();
  const filter =
    target.planId !== undefined
      ? sql`p.id = ${target.planId}::uuid`
      : sql`pr.slug = ${target.slug ?? ""}`;

  // One read, everything the table needs. `has_signing_key` is a BOOLEAN
  // projection — the sealed key blob is deliberately never selected.
  const rows = unwrapRows<PlanRow>(
    await db.execute(sql`
      select
        p.id as plan_id, p.status, p.quantity, p.per_plan_ceiling_wei,
        p.fire_at, p.armed_at, p.armed_until, p.cached_tx, p.presigned_at,
        w.id as wallet_id, w.address as wallet_address, w.label as wallet_label,
        w.enabled as wallet_enabled,
        (w.encrypted_signing_key is not null) as has_signing_key,
        p.project_id, pr.slug as project_slug, pr.name as project_name, pr.chain_id,
        s.id as stage_id, s.label as stage_label, s.type as stage_kind, s.paused as stage_paused,
        s.starts_at as stage_starts_at, s.ends_at as stage_ends_at, s.max_per_wallet,
        s.price_wei as stage_price_wei, s.currency as stage_currency
      from mint_plans p
        join wallets w on w.id = p.wallet_id
        join projects pr on pr.id = p.project_id
        left join drop_stages s on s.id = p.stage_id
      where p.status in ('armed', 'draft') and ${filter}
      order by coalesce(p.fire_at, s.starts_at) asc nulls last, p.created_at asc
    `),
  );

  const label = target.planId ?? target.slug ?? "?";
  const chainId = rows[0]?.chain_id ?? config.ROBINHOOD_CHAIN_ID;

  console.log("");
  console.log(
    `PRE-FLIGHT  target=${label}  chain=${chainId}  now=${formatDateTimeGmt7(new Date(nowMs))}`,
  );
  console.log("");

  /* Shared: RPC health for every endpoint the broadcast path would use. */
  // Use the SAME endpoint list the fire path uses, not the registry alone.
  // Premium endpoints are deliberately kept out of `rpc_endpoints` so that
  // background jobs cannot spend their rate limit (see apps/worker/src/
  // mint-rpc.ts), which meant this tool was reading only the public RPC and
  // reporting every plan BLOCKED on "no reachable RPC" while the real fire
  // path had two healthy premium endpoints. A readiness check that does not
  // check what actually runs is worse than no check.
  const registryUrls = await resolveBroadcastRpcUrls(db, chainId, config.RPC_URL, 8);
  const broadcastUrls = mintRpcUrls(config, registryUrls);
  const bestUrl = broadcastUrls[0] ?? (await resolveBestRpcUrl(db, chainId, config.RPC_URL));
  const probes = await Promise.all(broadcastUrls.map((url) => probeRpc(url)));
  const reachable = probes.filter((p) => p.error === null);
  const rpcUrl = reachable.find((p) => p.url === bestUrl)?.url ?? reachable[0]?.url ?? null;

  const globalLines: CheckLine[] = [];
  console.log(`RPC  ${broadcastUrls.length} endpoint(s) on the broadcast path`);
  if (broadcastUrls.length === 0) {
    const line: CheckLine = {
      level: "BLOCKER",
      label: "rpc",
      detail: "no RPC endpoint configured (empty registry and no RPC_URL) — nothing can broadcast",
    };
    globalLines.push(line);
    printCheck(line);
  }
  for (const probe of probes) {
    const line: CheckLine = {
      level: probe.error === null ? "OK" : "BLOCKER",
      label: probe.url === bestUrl ? "rpc (primary)" : "rpc",
      detail:
        probe.error === null
          ? `${probe.url} — ${probe.latencyMs} ms round-trip`
          : `${probe.url} — UNREACHABLE after ${probe.latencyMs} ms: ${probe.error}`,
    };
    globalLines.push(line);
    printCheck(line);
  }

  /* Shared: the stored chain clock offset and how old it is. */
  const offsetMs = (await getSetting<number>(db, CHAIN_CLOCK_OFFSET_SETTING_KEY)) ?? null;
  const measuredAtMs = await getSetting<number>(db, CHAIN_CLOCK_OFFSET_MEASURED_AT_SETTING_KEY);
  const clockLine: CheckLine =
    offsetMs === null
      ? {
          level: "WARN",
          label: "chain clock",
          detail: "no stored offset — fire timing falls back to the raw OS clock",
        }
      : {
          level: measuredAtMs === undefined || nowMs - measuredAtMs > 900_000 ? "WARN" : "OK",
          label: "chain clock",
          detail:
            `offset ${offsetMs >= 0 ? "+" : ""}${offsetMs} ms (local − chain) · measured ` +
            (measuredAtMs === undefined
              ? "at an unknown time"
              : `${formatDuration(nowMs - measuredAtMs)} ago`),
        };
  globalLines.push(clockLine);
  printCheck(clockLine);
  console.log("");

  if (rows.length === 0) {
    const line: CheckLine = {
      level: "BLOCKER",
      label: "plans",
      detail: `no armed or draft mint plan matches ${label} — nothing is set up to mint`,
    };
    globalLines.push(line);
    printCheck(line);
    console.log("");
    console.log("SUMMARY  0 plans ready, 1 blocked");
    process.exitCode = 1;
    return;
  }

  /* Nonce collisions are a property of the WALLET, not of the rows being
   * printed: a `--plan` run must still see the sibling plan that will take the
   * same nonce. Pull every open plan on this chain's wallets and match in JS. */
  const siblings = unwrapRows<{
    plan_id: string;
    wallet_id: string;
    project_id: string;
    quantity: number;
    fire_target: string | Date | null;
  }>(
    await db.execute(sql`
      select p.id as plan_id, p.wallet_id, p.project_id, p.quantity,
             coalesce(p.fire_at, s.starts_at) as fire_target
      from mint_plans p
        left join drop_stages s on s.id = p.stage_id
      where p.status in ('armed', 'draft')
    `),
  ).map(
    (r): SiblingPlan => ({
      planId: r.plan_id,
      walletId: r.wallet_id,
      projectId: r.project_id,
      quantity: Number(r.quantity),
      fireTargetMs: r.fire_target === null ? null : coerceDate(r.fire_target).getTime(),
    }),
  );

  /* Per-wallet chain reads, once per distinct wallet. */
  const walletFacts = new Map<string, WalletFacts>();
  const distinctWallets = [...new Map(rows.map((r) => [r.wallet_id, r.wallet_address])).entries()];
  await Promise.all(
    distinctWallets.map(async ([walletId, address]) => {
      walletFacts.set(
        walletId,
        rpcUrl === null
          ? {
              nonce: null,
              maxFeePerGasWei: null,
              nativeBalanceWei: null,
              error: "no reachable RPC",
            }
          : await readWalletFacts(rpcUrl, address),
      );
    }),
  );

  const knobs: FireKnobs = {
    hotWindowMs: config.MINT_FIRE_HOT_WINDOW_MS,
    leadMs: config.MINT_FIRE_LEAD_MS,
    continueForMs: config.MINT_FIRE_CONTINUE_MS,
  };
  const gasLimit = BigInt(config.MINT_PRESIGN_GAS_LIMIT);

  let ready = 0;
  let blocked = 0;
  let warned = 0;

  for (const [index, row] of rows.entries()) {
    const facts = walletFacts.get(row.wallet_id) ?? {
      nonce: null,
      maxFeePerGasWei: null,
      nativeBalanceWei: null,
      error: "wallet not read",
    };
    const rpcUsable = rpcUrl !== null && facts.error === null;
    const spender = row.cached_tx?.to ?? SEADROP_ADDRESS;
    const spenderSource = row.cached_tx?.to === undefined ? "SeaDrop default" : "plan cached_tx.to";

    const lines: CheckLine[] = [
      checkState(row),
      ...checkArmWindow(row, nowMs),
      ...checkFirePhase(row, nowMs, offsetMs ?? 0, knobs),
      ...checkStage(row),
      checkNativeFunding(row, facts, gasLimit, rpcUsable),
      ...(await checkErc20(row, rpcUsable ? rpcUrl : null, spender, spenderSource)),
      ...checkNonce(row, facts, siblings, rpcUsable),
    ];

    const verdict = worst(lines);
    const walletName = row.wallet_label ?? shortAddress(row.wallet_address);
    console.log(
      `PLAN ${index + 1}/${rows.length}  ${marker(verdict)}${shortId(row.plan_id)}  ` +
        `${row.project_slug ?? row.project_name}  wallet=${walletName} ${shortAddress(row.wallet_address)}`,
    );
    for (const line of lines) {
      printCheck(line);
    }
    console.log("");

    if (verdict === "BLOCKER") {
      blocked += 1;
    } else {
      ready += 1;
      if (verdict === "WARN") {
        warned += 1;
      }
    }
  }

  // A dead endpoint among several healthy ones is not fatal — the fire path
  // races them and needs only one. Only treat the shared checks as blocking
  // when NOTHING is reachable.
  const rpcLines = globalLines.filter((l) => l.label.startsWith("rpc"));
  const anyRpcOk = rpcLines.some((l) => l.level === "OK");
  const globalBlocked = globalLines.some(
    (l) => l.level === "BLOCKER" && !(l.label.startsWith("rpc") && anyRpcOk),
  );
  console.log(`SUMMARY  ${ready} plans ready, ${blocked} blocked`);
  if (warned > 0) {
    console.log(`         ${warned} of the ready plans carry a WARN — read the rows above`);
  }
  if (globalBlocked) {
    console.log("         shared RPC/clock checks contain a BLOCKER — no plan can be called ready");
  }
  process.exitCode = blocked > 0 || globalBlocked ? 1 : 0;
}

/**
 * A tool used two hours before real money is spent must fail in one readable
 * line, not a stack trace: the driver buries the actual reason (a refused DB
 * socket, a bad URL) in `cause` under a full query dump, so unwrap it and keep
 * the first line only. The message is an error string — never an env value.
 */
function rootCauseMessage(error: unknown): string {
  let current: unknown = error;
  let message = String(error);
  for (let depth = 0; depth < 5; depth += 1) {
    if (!(current instanceof Error)) {
      break;
    }
    message = current.message;
    const cause: unknown = current.cause;
    if (cause === undefined || cause === null) {
      break;
    }
    current = cause;
    if (current instanceof Error) {
      message = current.message;
    }
  }
  // A config error lists one missing variable per line and every line matters;
  // a driver error's first line is the whole story and the rest is a dump.
  const lines = message.split("\n");
  const kept = message.startsWith("Invalid environment configuration")
    ? lines.slice(0, 12)
    : lines.slice(0, 1);
  return kept.map((line) => line.trim().slice(0, 200)).join("; ");
}

main().catch((error: unknown) => {
  console.error(
    `  ${marker("BLOCKER")}preflight    could not complete: ${rootCauseMessage(error)}`,
  );
  console.error("SUMMARY  0 plans ready, 1 blocked");
  process.exitCode = 1;
});

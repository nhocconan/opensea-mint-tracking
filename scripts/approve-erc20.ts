/**
 * One-time ERC-20 approval for managed burner wallets (2026-09-15).
 *
 * Why this exists: a SeaDrop phase priced in an ERC-20 (USDG on Robinhood
 * Chain) pulls the price with `transferFrom`, so the mint contract must
 * already hold an allowance from the minting wallet. A repo-wide grep
 * confirms `approve(` is encoded NOWHERE in packages/ or apps/ — the fire
 * path never sends one — so a token-priced mint reverts in simulation and
 * keeps retrying until the window closes. Until approval is built into the
 * fire path, the operator runs this once per wallet BEFORE the window.
 *
 * Design rules this file obeys (AGENTS.md + the money/custody rules):
 *  - DRY RUN IS THE DEFAULT. Nothing is signed or broadcast without
 *    `--execute`.
 *  - No new key handling: the sealed blob is opened with @hoodmint/secrets'
 *    `openWalletKey` and handed straight to @hoodmint/signing's
 *    `signManagedMintTransaction` — the same chokepoint the worker's
 *    managed-key fire path uses. The plaintext is function-scoped, never
 *    logged, never returned, and any error raised anywhere near it is
 *    replaced with a fixed message so no key material can leak through an
 *    exception string.
 *  - bigint only for amounts, gas and fees. No float, no Number() on money.
 *  - Success is a MINED RECEIPT, never mempool acceptance: the script polls
 *    eth_getTransactionReceipt and reports the on-chain status field. (The
 *    opposite mistake — reporting success on broadcast — is a confirmed
 *    defect elsewhere in this repo; it is not repeated here.)
 *
 * Usage: see `--help`.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { type AppConfig, loadEnv } from "@hoodmint/config";
import { formatUnitsShort, rankRpcEndpoints } from "@hoodmint/core";
import {
  createDb,
  type Db,
  dbClient,
  getWalletSigningKeySealed,
  listRpcEndpoints,
  listWallets,
} from "@hoodmint/db";
import {
  broadcastRawTransaction,
  fetchErc20Funding,
  fetchFeeContext,
  fetchNativeBalance,
  simulateTransaction,
} from "@hoodmint/providers";
import { openWalletKey, redactUrl } from "@hoodmint/secrets";
import { managedKeyAddress, signManagedMintTransaction } from "@hoodmint/signing";
import {
  type Address,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  hexToBigInt,
  http,
  isAddress,
  parseUnits,
} from "viem";

/** `type(uint256).max` — the unlimited-approval sentinel every ERC-20 treats
 *  as "never decrement the allowance". Default because a bounded approval
 *  that runs out mid-window costs a second transaction inside the FCFS race. */
const MAX_UINT256 = (1n << 256n) - 1n;

/** Generous compared to the fire path's 800ms budget: this script runs ahead
 *  of the window, so correctness beats latency. */
const RPC_TIMEOUT_MS = 15_000;
const RECEIPT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_CONFIRM_TIMEOUT_SECONDS = 180;
/** Same headroom the worker applies over a simulated estimate. */
const GAS_HEADROOM_NUMERATOR = 120n;
const GAS_HEADROOM_DENOMINATOR = 100n;

const HELP = `approve-erc20 — one-time ERC-20 approval for managed burner wallets

  DRY RUN BY DEFAULT. Without --execute nothing is signed and nothing is sent.

USAGE
  tsx scripts/approve-erc20.ts --token <0x..> --spender <0x..> \\
      (--wallet <address|label> [--wallet ...] | --all-wallets) [options]

REQUIRED
  --token <0x...>        ERC-20 the mint is priced in (USDG). Source:
                         drop_stages.currency for the phase you are minting.
  --spender <0x...>      Contract that pulls the price with transferFrom —
                         the mint target. Source: execution_attempts.pending_tx
                         ->>'to' for this project, i.e. the "target" OpenSea
                         returns from POST /api/v2/drops/<slug>/mint.

WALLET SELECTION (one of)
  --wallet <address|label>   Repeatable. Matches wallets.address (case
                             insensitive) or an exact wallets.label.
  --all-wallets              Every enabled wallet that has a managed key.

OPTIONS
  --amount <decimal>     Bounded approval in WHOLE TOKEN units (e.g. 250.5),
                         converted with the token's own decimals. Default:
                         unlimited (2^256-1).
  --amount-raw <integer> Bounded approval in BASE units (no decimal point).
  --chain-id <n>         Run against a chain id other than the configured
                         Robinhood Chain id. Refused without this flag.
  --rpc-url <url>        Override RPC selection (default: best-ranked enabled
                         rpc_endpoints row for the chain, else RPC_URL).
  --confirm-timeout <s>  Receipt poll budget per tx. Default ${DEFAULT_CONFIRM_TIMEOUT_SECONDS}s.
  --execute              Actually sign and broadcast. Omit to dry-run.
  -h, --help             This text.

ENVIRONMENT
  Reads the normal app env (DATABASE_URL, APP_ENCRYPTION_KEY,
  WALLET_KEY_PRIVATE_KEY, ROBINHOOD_CHAIN_ID, RPC_URL). Run it where the
  worker's env is present — e.g. inside the worker container.

SAFETY
  Never prints key material. Reads the current allowance first and skips any
  wallet already at or above the requested amount. Reports success only after
  eth_getTransactionReceipt returns a mined receipt with status 0x1.
`;

interface Options {
  readonly walletSelectors: readonly string[];
  readonly allWallets: boolean;
  readonly token: Address;
  readonly spender: Address;
  readonly amountRaw: bigint | undefined;
  readonly amountDecimal: string | undefined;
  readonly chainIdOverride: number | undefined;
  readonly rpcUrlOverride: string | undefined;
  readonly confirmTimeoutMs: number;
  readonly execute: boolean;
}

class UsageError extends Error {}

/** Fail closed on anything that is not a well-formed 0x address. viem's
 *  `isAddress` accepts all-lowercase and validates the checksum of a
 *  mixed-case address, so a typo'd checksum is rejected here rather than
 *  silently approved against the wrong contract. */
function requireAddress(value: string | undefined, flag: string): Address {
  if (value === undefined || value.trim() === "") {
    throw new UsageError(`${flag} is required`);
  }
  const trimmed = value.trim();
  if (!isAddress(trimmed)) {
    throw new UsageError(`${flag} is not a well-formed 0x address: ${trimmed}`);
  }
  return getAddress(trimmed);
}

/** Positive integer from a flag, without ever letting a float near it. */
function requireInt(value: string, flag: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new UsageError(`${flag} must be a non-negative integer`);
  }
  return Number.parseInt(value.trim(), 10);
}

const optionSpec = {
  wallet: { type: "string", multiple: true },
  "all-wallets": { type: "boolean" },
  token: { type: "string" },
  spender: { type: "string" },
  amount: { type: "string" },
  "amount-raw": { type: "string" },
  "chain-id": { type: "string" },
  "rpc-url": { type: "string" },
  "confirm-timeout": { type: "string" },
  execute: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** parseArgs throws on an unknown flag or a missing value — surfaced as a
 *  usage error rather than a stack trace, so a typo'd flag fails closed. */
function rawParse(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: optionSpec,
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "could not parse arguments");
  }
}

function parseOptions(argv: readonly string[]): Options | "help" {
  const values = rawParse(argv).values;
  if (values.help === true) {
    return "help";
  }

  const walletSelectors = values.wallet ?? [];
  const allWallets = values["all-wallets"] === true;
  if (allWallets && walletSelectors.length > 0) {
    throw new UsageError("--all-wallets and --wallet are mutually exclusive");
  }
  if (!allWallets && walletSelectors.length === 0) {
    throw new UsageError("pass --wallet <address|label> (repeatable) or --all-wallets");
  }
  if (values.amount !== undefined && values["amount-raw"] !== undefined) {
    throw new UsageError("pass --amount or --amount-raw, not both");
  }

  let amountRaw: bigint | undefined;
  if (values["amount-raw"] !== undefined) {
    const raw = values["amount-raw"].trim();
    if (!/^\d+$/.test(raw)) {
      throw new UsageError("--amount-raw must be a non-negative integer in base units");
    }
    amountRaw = BigInt(raw);
  }
  if (values.amount !== undefined && !/^\d+(\.\d+)?$/.test(values.amount.trim())) {
    throw new UsageError("--amount must be a non-negative decimal number of whole tokens");
  }

  return {
    walletSelectors,
    allWallets,
    token: requireAddress(values.token, "--token"),
    spender: requireAddress(values.spender, "--spender"),
    amountRaw,
    amountDecimal: values.amount?.trim(),
    chainIdOverride:
      values["chain-id"] === undefined ? undefined : requireInt(values["chain-id"], "--chain-id"),
    rpcUrlOverride: values["rpc-url"]?.trim(),
    confirmTimeoutMs:
      (values["confirm-timeout"] === undefined
        ? DEFAULT_CONFIRM_TIMEOUT_SECONDS
        : requireInt(values["confirm-timeout"], "--confirm-timeout")) * 1000,
    execute: values.execute === true,
  };
}

interface WalletRow {
  readonly id: string;
  readonly address: string;
  readonly label: string | null;
  readonly hasSigningKey: boolean;
}

/** Resolve --wallet selectors against the wallets table. Ambiguity and
 *  misses are hard errors — approving the wrong wallet is unrecoverable. */
function selectWallets(rows: readonly WalletRow[], options: Options): WalletRow[] {
  if (options.allWallets) {
    const managed = rows.filter((w) => w.hasSigningKey);
    if (managed.length === 0) {
      throw new UsageError("--all-wallets matched no enabled wallet with a managed signing key");
    }
    return managed;
  }
  const selected: WalletRow[] = [];
  for (const selector of options.walletSelectors) {
    const needle = selector.trim().toLowerCase();
    const matches = rows.filter(
      (w) => w.address.toLowerCase() === needle || (w.label ?? "").toLowerCase() === needle,
    );
    if (matches.length === 0) {
      throw new UsageError(`no enabled wallet matches '${selector}'`);
    }
    if (matches.length > 1) {
      throw new UsageError(
        `'${selector}' matches ${matches.length} wallets — use the address instead`,
      );
    }
    const match = matches[0];
    if (match !== undefined && !selected.some((w) => w.id === match.id)) {
      selected.push(match);
    }
  }
  return selected;
}

/** Same precedence as the worker's resolveBestRpcUrl and the web funding
 *  gate: best-ranked enabled endpoint that is not known-down, else RPC_URL. */
async function resolveRpcUrl(db: Db, config: AppConfig, chainId: number): Promise<string> {
  const endpoints = await listRpcEndpoints(db, chainId).catch(() => []);
  const best = rankRpcEndpoints(endpoints, chainId).find((e) => e.healthStatus !== "down");
  const url = best?.httpUrl ?? config.RPC_URL;
  if (url === undefined || url.trim() === "") {
    throw new UsageError(
      `no RPC endpoint for chain ${chainId}: add one in Admin → RPC endpoints, set RPC_URL, or pass --rpc-url`,
    );
  }
  return url;
}

/** Endpoint identity without its credential: a premium RPC often carries its
 *  API key in the PATH (`/v2/<key>`), which redactUrl's query-string rules do
 *  not catch, so only the origin is printed. */
function describeRpc(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).origin;
  } catch {
    return redactUrl(rpcUrl);
  }
}

interface Receipt {
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly gasUsed: bigint;
  readonly effectiveGasPriceWei: bigint;
}

/**
 * Poll eth_getTransactionReceipt until the tx is MINED. A null answer means
 * "still pending", which is exactly the state that must never be reported as
 * success. Returns undefined only when the budget expires — the caller then
 * reports "unconfirmed", not "sent ok".
 */
async function waitForReceipt(
  client: ReturnType<typeof createPublicClient>,
  txHash: Hex,
  timeoutMs: number,
): Promise<Receipt | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await client
      .request({ method: "eth_getTransactionReceipt", params: [txHash] })
      .catch(() => null);
    if (raw !== null && raw !== undefined) {
      return {
        status: raw.status === "0x1" ? "success" : "reverted",
        blockNumber: raw.blockNumber === null ? 0n : hexToBigInt(raw.blockNumber),
        gasUsed: hexToBigInt(raw.gasUsed),
        effectiveGasPriceWei: hexToBigInt(raw.effectiveGasPrice),
      };
    }
    await sleep(RECEIPT_POLL_INTERVAL_MS);
  }
  return undefined;
}

function describeAmount(amount: bigint, decimals: number, symbol: string): string {
  if (amount === MAX_UINT256) {
    return `UNLIMITED (2^256-1) ${symbol}`;
  }
  return `${formatUnitsShort(amount, decimals)} ${symbol} (${amount.toString(10)} base units)`;
}

function walletName(wallet: WalletRow): string {
  return wallet.label === null || wallet.label === ""
    ? wallet.address
    : `${wallet.label} (${wallet.address})`;
}

interface WalletOutcome {
  readonly wallet: WalletRow;
  readonly state:
    | "already_approved"
    | "would_approve"
    | "approved"
    | "reverted"
    | "unconfirmed"
    | "skipped"
    | "failed";
  readonly detail: string;
  readonly finalAllowance: bigint | undefined;
}

/**
 * One wallet, start to finish: read → skip-or-plan → sign → broadcast →
 * confirm → read back. Deliberately one linear procedure, because the
 * operator reads its output top-to-bottom while deciding whether to fire.
 */
async function processWallet(
  db: Db,
  config: AppConfig,
  options: Options,
  context: {
    readonly rpcUrl: string;
    readonly chainId: number;
    readonly client: ReturnType<typeof createPublicClient>;
    readonly amount: bigint;
    readonly decimals: number;
    readonly symbol: string;
  },
  wallet: WalletRow,
): Promise<WalletOutcome> {
  const { rpcUrl, chainId, client, amount, decimals, symbol } = context;
  console.log("");
  console.log(`── ${walletName(wallet)}`);

  const funding = await fetchErc20Funding(rpcUrl, options.token, wallet.address, options.spender);
  const allowance = funding.allowance ?? 0n;
  console.log(`   token balance   : ${formatUnitsShort(funding.balance, decimals)} ${symbol}`);
  console.log(`   allowance now   : ${describeAmount(allowance, decimals, symbol)}`);

  if (allowance >= amount) {
    console.log("   → already approved (allowance ≥ requested) — skipping, no gas spent");
    return {
      wallet,
      state: "already_approved",
      detail: "allowance already at or above requested",
      finalAllowance: allowance,
    };
  }

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [options.spender, amount],
  });

  const [nativeBalanceWei, fees, simulation] = await Promise.all([
    fetchNativeBalance(rpcUrl, wallet.address),
    fetchFeeContext(rpcUrl, wallet.address, { timeoutMs: RPC_TIMEOUT_MS }),
    simulateTransaction({
      rpcUrl,
      from: wallet.address,
      to: options.token,
      data,
      valueWei: "0",
      timeoutMs: RPC_TIMEOUT_MS,
    }),
  ]);

  if (!simulation.ok) {
    console.log(`   → simulation REVERTED: ${simulation.revertReason}`);
    return {
      wallet,
      state: "failed",
      detail: `simulation reverted: ${simulation.revertReason}`,
      finalAllowance: allowance,
    };
  }

  const gas = (simulation.gasEstimate * GAS_HEADROOM_NUMERATOR) / GAS_HEADROOM_DENOMINATOR;
  const maxFeePerGasWei = BigInt(fees.maxFeePerGasWei);
  const estimatedFeeWei = gas * maxFeePerGasWei;

  console.log(`   native balance  : ${formatUnitsShort(nativeBalanceWei, 18, 8)}`);
  console.log(`   from            : ${wallet.address}`);
  console.log(`   to (token)      : ${options.token}`);
  console.log(`   spender         : ${options.spender}`);
  console.log(`   approve amount  : ${describeAmount(amount, decimals, symbol)}`);
  console.log(`   calldata        : ${data}`);
  console.log(`   nonce           : ${fees.nonce}`);
  console.log(`   gas (est +20%)  : ${simulation.gasEstimate.toString(10)} → ${gas.toString(10)}`);
  console.log(`   maxFeePerGas    : ${maxFeePerGasWei.toString(10)} wei`);
  console.log(
    `   estimated fee   : ${estimatedFeeWei.toString(10)} wei (${formatUnitsShort(estimatedFeeWei, 18, 8)})`,
  );
  if (nativeBalanceWei < estimatedFeeWei) {
    console.log("   ! native balance is below the estimated fee — fund this wallet first");
  }

  if (!options.execute) {
    console.log("   → DRY RUN: nothing signed, nothing sent. Re-run with --execute to broadcast.");
    return {
      wallet,
      state: "would_approve",
      detail: "dry run",
      finalAllowance: allowance,
    };
  }

  if (!wallet.hasSigningKey) {
    console.log("   → no managed signing key on this wallet — cannot sign here");
    return {
      wallet,
      state: "skipped",
      detail: "no managed signing key",
      finalAllowance: allowance,
    };
  }
  const sealed = await getWalletSigningKeySealed(db, wallet.id);
  if (sealed === undefined) {
    console.log("   → sealed key row disappeared — skipping");
    return { wallet, state: "skipped", detail: "no sealed key", finalAllowance: allowance };
  }

  // Everything that touches plaintext key material lives inside this block,
  // and ANY error from it is replaced with a fixed message: viem and the
  // crypto layer can echo their input into an exception string, and a key
  // must never reach a console, a log or an exit code path.
  let rawTx: Hex;
  let expectedTxHash: string;
  try {
    const privateKeyHex = openWalletKey(sealed, {
      masterKeyB64: config.APP_ENCRYPTION_KEY,
      walletPrivateKeyB64: config.WALLET_KEY_PRIVATE_KEY,
    });
    if (managedKeyAddress(privateKeyHex).toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error("address mismatch");
    }
    const signed = await signManagedMintTransaction(
      {
        chainId,
        to: options.token,
        data,
        valueWei: "0",
        nonce: fees.nonce,
        maxFeePerGasWei: fees.maxFeePerGasWei,
        maxPriorityFeePerGasWei: fees.maxPriorityFeePerGasWei,
        gas,
      },
      privateKeyHex,
    );
    rawTx = signed.rawTx;
    expectedTxHash = signed.txHash;
  } catch {
    console.log("   → could not open or use this wallet's sealed key (details withheld)");
    return {
      wallet,
      state: "failed",
      detail: "sealed key could not be opened, did not match the wallet address, or failed to sign",
      finalAllowance: allowance,
    };
  }

  console.log(`   broadcasting    : ${expectedTxHash}`);
  const broadcast = await broadcastRawTransaction(rpcUrl, rawTx, RPC_TIMEOUT_MS);
  const txHash = broadcast.txHash as Hex;
  console.log(`   accepted by RPC : ${txHash} — NOT yet confirmed, polling receipt…`);

  const receipt = await waitForReceipt(client, txHash, options.confirmTimeoutMs);
  if (receipt === undefined) {
    console.log(
      `   → UNCONFIRMED after ${options.confirmTimeoutMs / 1000}s — the tx may still mine. Check ${txHash} before assuming anything.`,
    );
    return {
      wallet,
      state: "unconfirmed",
      detail: `no receipt within budget (${txHash})`,
      finalAllowance: undefined,
    };
  }

  const paidWei = receipt.gasUsed * receipt.effectiveGasPriceWei;
  console.log(
    `   receipt         : status=${receipt.status} block=${receipt.blockNumber.toString(10)} gasUsed=${receipt.gasUsed.toString(10)} paid=${paidWei.toString(10)} wei`,
  );
  const after = await fetchErc20Funding(rpcUrl, options.token, wallet.address, options.spender);
  const finalAllowance = after.allowance ?? 0n;
  console.log(`   allowance after : ${describeAmount(finalAllowance, decimals, symbol)}`);

  if (receipt.status !== "success") {
    return { wallet, state: "reverted", detail: txHash, finalAllowance };
  }
  return { wallet, state: "approved", detail: txHash, finalAllowance };
}

async function run(options: Options): Promise<number> {
  const config = loadEnv();
  const chainId = options.chainIdOverride ?? config.ROBINHOOD_CHAIN_ID;
  const db = createDb(config.DATABASE_URL, { max: 1, applicationName: "approve-erc20" });
  try {
    const rpcUrl = options.rpcUrlOverride ?? (await resolveRpcUrl(db, config, chainId));
    const client = createPublicClient({
      transport: http(rpcUrl, { retryCount: 1, timeout: RPC_TIMEOUT_MS }),
    });

    // Chain-id gate. The configured Robinhood Chain id is the only chain this
    // tool runs against by default: an approval broadcast on the wrong chain
    // grants a real allowance to whatever contract happens to sit at that
    // address there, and cannot be taken back without another transaction.
    const liveChainId = await client.getChainId();
    if (liveChainId !== chainId) {
      console.error(
        `REFUSED: the RPC at ${describeRpc(rpcUrl)} reports chain id ${liveChainId}, but this run targets ${chainId}.`,
      );
      console.error(
        "  An approval sent to the wrong chain grants a real, irreversible allowance there.",
      );
      console.error(
        `  If that is genuinely what you want, re-run with --chain-id ${liveChainId} and a matching --rpc-url.`,
      );
      return 2;
    }
    if (
      options.chainIdOverride !== undefined &&
      options.chainIdOverride !== config.ROBINHOOD_CHAIN_ID
    ) {
      console.log(
        `! --chain-id ${options.chainIdOverride} overrides the configured Robinhood Chain id ${config.ROBINHOOD_CHAIN_ID}.`,
      );
    }

    const rows = (await listWallets(db, { enabledOnly: true })).map((w) => ({
      id: w.id,
      address: w.address,
      label: w.label,
      hasSigningKey: w.hasSigningKey,
    }));
    const wallets = selectWallets(rows, options);

    const [symbol, decimalsRaw] = await Promise.all([
      client
        .readContract({ address: options.token, abi: erc20Abi, functionName: "symbol" })
        .catch(() => "token"),
      client
        .readContract({ address: options.token, abi: erc20Abi, functionName: "decimals" })
        .catch(() => 18),
    ]);
    const decimals = Number(decimalsRaw);

    // parseUnits is string-based bigint math — the decimal string never
    // becomes a float on the way to base units.
    const amount =
      options.amountRaw !== undefined
        ? options.amountRaw
        : options.amountDecimal !== undefined
          ? parseUnits(options.amountDecimal, decimals)
          : MAX_UINT256;

    console.log(
      options.execute ? "MODE: EXECUTE (will broadcast)" : "MODE: DRY RUN (sends nothing)",
    );
    console.log(`chain id  : ${chainId}`);
    console.log(`rpc       : ${describeRpc(rpcUrl)}`);
    console.log(`token     : ${options.token} (${symbol}, ${decimals} decimals)`);
    console.log(`spender   : ${options.spender}`);
    console.log(`amount    : ${describeAmount(amount, decimals, symbol)}`);
    console.log(`wallets   : ${wallets.length}`);
    if (amount === MAX_UINT256) {
      console.log(
        `!! UNLIMITED APPROVAL: ${options.spender} will be able to spend ALL ${symbol} held by each wallet below, forever, until revoked with --amount-raw 0.`,
      );
    }

    const outcomes: WalletOutcome[] = [];
    for (const wallet of wallets) {
      try {
        outcomes.push(
          await processWallet(
            db,
            config,
            options,
            { rpcUrl, chainId, client, amount, decimals, symbol },
            wallet,
          ),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message.slice(0, 300) : "unknown error";
        console.log(`   → FAILED: ${detail}`);
        outcomes.push({ wallet, state: "failed", detail, finalAllowance: undefined });
      }
    }

    console.log("");
    console.log("SUMMARY");
    for (const outcome of outcomes) {
      const allowance =
        outcome.finalAllowance === undefined
          ? "unknown (not read back)"
          : describeAmount(outcome.finalAllowance, decimals, symbol);
      console.log(`  ${outcome.state.padEnd(17)} ${walletName(outcome.wallet)}`);
      console.log(`  ${"".padEnd(17)} allowance: ${allowance}`);
      if (outcome.detail !== "") {
        console.log(`  ${"".padEnd(17)} ${outcome.detail}`);
      }
    }
    if (!options.execute) {
      console.log("");
      console.log("Dry run only — no transaction was signed or sent.");
    }

    const bad = outcomes.filter(
      (o) => o.state === "failed" || o.state === "reverted" || o.state === "unconfirmed",
    );
    return bad.length > 0 ? 1 : 0;
  } finally {
    await dbClient(db).end({ timeout: 5 });
  }
}

async function main(): Promise<number> {
  let options: Options | "help";
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof UsageError ? `error: ${error.message}` : String(error));
    console.error("");
    console.error(HELP);
    return 2;
  }
  if (options === "help") {
    console.log(HELP);
    return 0;
  }
  try {
    return await run(options);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}`);
      return 2;
    }
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Not top-level `await`: the nearest package.json has no `"type": "module"`,
// so tsx transforms scripts/*.ts as CJS and top-level await fails to build.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);

import { deriveRpcUrl, rpcUrlServesChain } from "@hoodmint/core";
/**
 * RPC routing for the mint fire path only.
 *
 * Premium endpoints (Alchemy, Chainstack) are paid, rate-limited per account,
 * and must be reserved for minting. Putting them in the `rpc_endpoints`
 * registry made them the best endpoint for EVERYTHING — and on 2026-09-15 at
 * 22:00:03, three seconds into a live mint, `chain-sync`'s `eth_getLogs`
 * earned a 429 from Alchemy. Background work must never be able to spend the
 * budget the fire path depends on.
 *
 * So the registry stays public-only, and the fire path builds its own ordered
 * list here: premium first, registry last. Order is preference, not
 * exclusivity — every consumer falls through to the next endpoint, because a
 * single premium endpoint is a single point of failure, which is the bug we
 * just spent the evening removing.
 */

export interface MintRpcConfig {
  readonly ALCHEMY_ROBINHOOD_RPC?: string | undefined;
  readonly CHAINSTACK_ROBINHOOD_RPC?: string | undefined;
  readonly DRPC_ROBINHOOD_RPC?: string | undefined;
  readonly RPC_URL?: string | undefined;
}

/**
 * Preference order for the fire path, fastest first.
 *
 * Ordered by the call the fire path actually depends on —
 * `eth_getTransactionCount(…, "pending")` — NOT by `eth_chainId`.
 *
 * Measured 2026-09-16 from this host, five calls each:
 *   method                    dRPC     Chainstack   Alchemy
 *   eth_chainId                66 ms      68 ms      133 ms
 *   eth_getTransactionCount   528 ms     195 ms      130 ms
 *
 * The ranking REVERSES. `eth_chainId` is answered from memory and measures
 * nothing but the network hop; the pending nonce requires a real state
 * lookup. Ordering by the cheap call put the slowest provider first and cost
 * 265 ms on the 21:00 GTD, where the prefetch was still in flight when the
 * signature was ready. Benchmark the method you depend on.
 */
const PROVIDER_ORDER = [
  "ALCHEMY_ROBINHOOD_RPC",
  "CHAINSTACK_ROBINHOOD_RPC",
  "DRPC_ROBINHOOD_RPC",
] as const;

/**
 * Ordered, de-duplicated endpoints for the fire path: premium providers
 * first, then whatever the registry and env offer. Different providers on
 * purpose — two URLs from one provider share one rate limit and one outage.
 */
export function mintRpcUrls(config: MintRpcConfig, registryUrls: readonly string[] = []): string[] {
  const out: string[] = [];
  const push = (url: string | undefined) => {
    if (url !== undefined && url.trim() !== "" && !out.includes(url)) {
      out.push(url);
    }
  };
  for (const key of PROVIDER_ORDER) {
    push(config[key]);
  }
  for (const url of registryUrls) {
    push(url);
  }
  push(config.RPC_URL);
  return out;
}

/**
 * Run `fn` against each endpoint in turn until one succeeds.
 *
 * Sequential, not raced: these are READ calls (nonce, fees, receipt) where a
 * second concurrent request buys nothing and spends budget on an endpoint we
 * are trying to conserve. Broadcast is the opposite case and races instead.
 * The last error is rethrown so the caller still sees a real reason.
 */
export async function withRpcFailover<T>(
  urls: readonly string[],
  fn: (url: string) => Promise<T>,
  onError?: (url: string, error: unknown) => void,
): Promise<T> {
  if (urls.length === 0) {
    throw new Error("withRpcFailover: no RPC endpoints configured");
  }
  let last: unknown;
  for (const url of urls) {
    try {
      return await fn(url);
    } catch (error) {
      last = error;
      onError?.(url, error);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Origin only — a premium URL carries its API key in the path. */
export function redactRpc(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "<unparseable-url>";
  }
}

/**
 * Open a connection to each endpoint so the broadcast at T is not paying for
 * a TCP + TLS handshake.
 *
 * Measured on the 2026-09-15 23:00 GTD: the transaction was signed 45.6ms
 * into the fire and only accepted at 436.2ms — ~390ms spent getting it onto
 * the wire. Node pools connections per origin, but the only traffic to these
 * hosts between mints is a health probe every 45s, so by the fire instant
 * every socket is cold and each costs two extra round-trips. A `eth_chainId`
 * is the cheapest call that establishes the connection.
 *
 * Fire-and-forget: warming is an optimisation, never a precondition.
 */
export async function warmRpcConnections(
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await Promise.allSettled(
    urls.map(async (url) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_500);
      try {
        await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
          signal: controller.signal,
        });
      } catch {
        // A cold endpoint that refuses a warm-up is simply not warmed.
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

/**
 * The same list, for a network other than the one the operator configured.
 *
 * Alchemy and dRPC encode the network as a replaceable token, so a single
 * configured endpoint per provider covers every chain they serve — the
 * operator enters each provider once, not once per network. Chainstack's path
 * is a per-node token and is silently dropped for other chains rather than
 * guessed, because a fabricated endpoint would only fail at the fire instant.
 *
 * Unlike `mintRpcUrls` this does NOT append `config.RPC_URL`: that env value
 * names one specific chain's public node, so it is meaningless for any other.
 * The caller's `registryUrls` already carries the right per-chain fallback,
 * because `resolveBroadcastRpcUrls` appends it for the chain it was asked about.
 */
export function mintRpcUrlsForChain(
  config: MintRpcConfig,
  chainId: number,
  registryUrls: readonly string[] = [],
): string[] {
  const out: string[] = [];
  const push = (url: string | undefined) => {
    if (url !== undefined && url.trim() !== "" && !out.includes(url)) {
      out.push(url);
    }
  };
  for (const key of PROVIDER_ORDER) {
    const template = config[key];
    if (template === undefined || template.trim() === "") {
      continue;
    }
    push(rpcUrlServesChain(template, chainId) ? template : deriveRpcUrl(template, chainId));
  }
  for (const url of registryUrls) {
    push(url);
  }
  return out;
}

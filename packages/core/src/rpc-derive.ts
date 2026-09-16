/**
 * Derive a provider's RPC URL for another network from the one URL the
 * operator already supplied.
 *
 * The operator should enter each provider's endpoint ONCE. Alchemy and dRPC
 * both encode the network as a replaceable token in the URL, so every other
 * chain they serve can be produced from a single example. Chainstack cannot:
 * its path segment is a per-node token, unique to the node that was created
 * for that one network, so a "derived" Chainstack URL would be a plausible
 * string that authenticates as nothing. It is refused rather than guessed.
 *
 * Shapes observed 2026-09-16 (keys redacted):
 *   alchemy     robinhood-mainnet.g.alchemy.com/v2/<key>   ← network in the subdomain
 *   drpc        lb.drpc.live/robinhood/<key>               ← network in the first path segment
 *   chainstack  robinhood-mainnet.core.chainstack.com/<token>  ← per-node token, NOT derivable
 */

export type RpcProvider = "alchemy" | "drpc" | "chainstack" | "unknown";

/** Canonical network keys, by EVM chain id. */
export const CHAIN_NETWORK_KEYS: Readonly<Record<number, string>> = {
  1: "ethereum",
  10: "optimism",
  137: "polygon",
  4663: "robinhood",
  8453: "base",
  42161: "arbitrum",
  81457: "blast",
  7777777: "zora",
};

/** How each provider spells a network inside its URL. */
const PROVIDER_SLUGS: Readonly<Record<string, { alchemy?: string; drpc?: string }>> = {
  ethereum: { alchemy: "eth-mainnet", drpc: "ethereum" },
  optimism: { alchemy: "opt-mainnet", drpc: "optimism" },
  polygon: { alchemy: "polygon-mainnet", drpc: "polygon" },
  robinhood: { alchemy: "robinhood-mainnet", drpc: "robinhood" },
  base: { alchemy: "base-mainnet", drpc: "base" },
  arbitrum: { alchemy: "arb-mainnet", drpc: "arbitrum" },
  blast: { alchemy: "blast-mainnet", drpc: "blast" },
  zora: { alchemy: "zora-mainnet", drpc: "zora" },
};

export function detectRpcProvider(url: string): RpcProvider {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (host.endsWith(".g.alchemy.com")) {
    return "alchemy";
  }
  if (host.endsWith(".drpc.org") || host.endsWith(".drpc.live")) {
    return "drpc";
  }
  if (host.endsWith(".core.chainstack.com")) {
    return "chainstack";
  }
  return "unknown";
}

/**
 * Rewrite `template` to point at `chainId`.
 *
 * Returns undefined when the provider does not encode the network in a
 * derivable position, or when the network is not one we know how to spell for
 * that provider. Never returns a guess: a wrong RPC URL fails at the fire
 * instant, which is the worst possible moment to discover it.
 */
export function deriveRpcUrl(template: string, chainId: number): string | undefined {
  const network = CHAIN_NETWORK_KEYS[chainId];
  if (network === undefined) {
    return undefined;
  }
  const provider = detectRpcProvider(template);
  const slugs = PROVIDER_SLUGS[network];
  if (slugs === undefined) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(template);
  } catch {
    return undefined;
  }
  if (provider === "alchemy") {
    if (slugs.alchemy === undefined) {
      return undefined;
    }
    // <network>-mainnet.g.alchemy.com — swap the leading label only.
    url.hostname = `${slugs.alchemy}.g.alchemy.com`;
    return url.toString();
  }
  if (provider === "drpc") {
    if (slugs.drpc === undefined) {
      return undefined;
    }
    // lb.drpc.live/<network>/<key> — swap the first path segment only.
    const segments = url.pathname.split("/").filter((s) => s !== "");
    if (segments.length === 0) {
      return undefined;
    }
    segments[0] = slugs.drpc;
    url.pathname = `/${segments.join("/")}`;
    return url.toString();
  }
  // chainstack and unknown: the network is not a replaceable token.
  return undefined;
}

/**
 * Which network a URL already points at, or undefined if unreadable.
 *
 * Deliberately separate from `deriveRpcUrl`: "can I rewrite this for another
 * chain" and "which chain is this for" are different questions, and conflating
 * them dropped Chainstack from the fire path for Robinhood itself — the chain
 * it was configured for — because Chainstack is not derivable. Its network IS
 * readable from the hostname even though its node token is not reproducible.
 */
export function rpcUrlNetwork(template: string): string | undefined {
  let url: URL;
  try {
    url = new URL(template);
  } catch {
    return undefined;
  }
  const provider = detectRpcProvider(template);
  if (provider === "alchemy" || provider === "chainstack") {
    // <network>-mainnet.g.alchemy.com / <network>-mainnet.core.chainstack.com
    const label = url.hostname.split(".")[0] ?? "";
    const network = label.replace(/-mainnet$/, "");
    return network === "" ? undefined : network;
  }
  if (provider === "drpc") {
    const first = url.pathname.split("/").find((s) => s !== "");
    return first;
  }
  return undefined;
}

/** True when `template` already serves `chainId` — no derivation needed. */
export function rpcUrlServesChain(template: string, chainId: number): boolean {
  const want = CHAIN_NETWORK_KEYS[chainId];
  if (want === undefined) {
    return false;
  }
  const have = rpcUrlNetwork(template);
  if (have === undefined) {
    return false;
  }
  if (have === want) {
    return true;
  }
  // Accept a provider spelling too (Alchemy writes "eth", we call it
  // "ethereum"), so a configured eth-mainnet URL is recognised for chain 1.
  const slugs = PROVIDER_SLUGS[want];
  return slugs?.alchemy?.replace(/-mainnet$/, "") === have || slugs?.drpc === have;
}

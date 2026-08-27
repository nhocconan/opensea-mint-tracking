/**
 * Supported-chain registry (multi-network foundation). The data model has
 * always been multi-chain — every chainId-bearing table (rpc_endpoints,
 * signers, mint_events, chain_checkpoints) is keyed by chain — but the
 * worker loop and config were hardcoded to Robinhood Chain (4663). This is
 * the single typed source of the per-chain facts everything else needs:
 * finality depth for the reorg/finalize window, the OpenSea chain slug for
 * discovery/eligibility, explorer URL builders, and the native currency.
 *
 * Pure and dependency-free so it's trivially testable and importable from
 * any layer. Adding a chain here (plus an enabled rpc_endpoints row for it)
 * is what makes the on-chain radar actually track it — no code change in
 * the sync loop, which iterates this registry ∩ configured endpoints.
 */

export interface ChainConfig {
  readonly chainId: number;
  readonly name: string;
  readonly shortName: string;
  /**
   * OpenSea's chain identifier for the drops/eligibility API, or null for a
   * chain OpenSea doesn't index (on-chain radar still works; OpenSea-sourced
   * discovery/eligibility simply doesn't apply).
   */
  readonly openSeaSlug: string | null;
  /** Blocks below head treated as final — the reorg-safety window. */
  readonly finalityDepth: number;
  readonly nativeCurrency: string;
  readonly explorerBaseUrl: string;
}

function explorerTxUrl(chain: ChainConfig, txHash: string): string {
  return `${chain.explorerBaseUrl}/tx/${txHash}`;
}
function explorerAddressUrl(chain: ChainConfig, address: string): string {
  return `${chain.explorerBaseUrl}/address/${address}`;
}

/**
 * The chains this build knows how to operate on. Robinhood Chain is the
 * primary target; the EVM L2s below are included because they're the common
 * OpenSea-drop chains an operator expanding beyond 4663 would reach for
 * first, and they share the same Arbitrum-Orbit / OP-stack finality shape.
 * Finality depths are conservative (a few blocks past typical L2 soft
 * finality); tune per chain if needed.
 */
export const CHAINS: Readonly<Record<number, ChainConfig>> = {
  4663: {
    chainId: 4663,
    name: "Robinhood Chain",
    shortName: "robinhood",
    openSeaSlug: "robinhood",
    finalityDepth: 12,
    nativeCurrency: "ETH",
    explorerBaseUrl: "https://robinscan.io",
  },
  1: {
    chainId: 1,
    name: "Ethereum",
    shortName: "ethereum",
    openSeaSlug: "ethereum",
    finalityDepth: 12,
    nativeCurrency: "ETH",
    explorerBaseUrl: "https://etherscan.io",
  },
  8453: {
    chainId: 8453,
    name: "Base",
    shortName: "base",
    openSeaSlug: "base",
    finalityDepth: 10,
    nativeCurrency: "ETH",
    explorerBaseUrl: "https://basescan.org",
  },
  42161: {
    chainId: 42161,
    name: "Arbitrum One",
    shortName: "arbitrum",
    openSeaSlug: "arbitrum",
    finalityDepth: 12,
    nativeCurrency: "ETH",
    explorerBaseUrl: "https://arbiscan.io",
  },
} as const;

export function getChain(chainId: number): ChainConfig | undefined {
  return CHAINS[chainId];
}

/** Finality depth for a chain, or a safe default for an unknown chain. */
export function finalityDepthFor(chainId: number, fallback = 12): number {
  return CHAINS[chainId]?.finalityDepth ?? fallback;
}

export function knownChainIds(): number[] {
  return Object.keys(CHAINS).map((k) => Number(k));
}

export function chainTxUrl(chainId: number, txHash: string): string | null {
  const chain = CHAINS[chainId];
  return chain === undefined ? null : explorerTxUrl(chain, txHash);
}

export function chainAddressUrl(chainId: number, address: string): string | null {
  const chain = CHAINS[chainId];
  return chain === undefined ? null : explorerAddressUrl(chain, address);
}

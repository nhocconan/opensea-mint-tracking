/**
 * Read-only wallet funding reads (2026-09-02). Native balance for the
 * arm-time / presign funding gate and the wallets-page snapshot, plus the
 * ERC-20 balance/allowance a token-priced SeaDrop stage needs. Pure reads:
 * nothing here signs, broadcasts or touches key material.
 */
import { type Address, createPublicClient, erc20Abi, http } from "viem";

function client(rpcUrl: string) {
  return createPublicClient({ transport: http(rpcUrl, { retryCount: 1 }) });
}

export async function fetchNativeBalance(rpcUrl: string, address: string): Promise<bigint> {
  return client(rpcUrl).getBalance({ address: address as Address });
}

/** Native balances for many addresses in parallel; a failed read is `null`
 *  so one dead address never hides the others. */
export async function fetchNativeBalances(
  rpcUrl: string,
  addresses: readonly string[],
): Promise<Map<string, bigint | null>> {
  const results = await Promise.all(
    addresses.map((address) =>
      fetchNativeBalance(rpcUrl, address).then(
        (balance) => [address, balance] as const,
        () => [address, null] as const,
      ),
    ),
  );
  return new Map(results);
}

export interface Erc20Funding {
  readonly balance: bigint;
  readonly allowance: bigint | undefined;
  readonly symbol: string;
  readonly decimals: number;
}

/** balanceOf(owner) (+ allowance(owner, spender) when a spender is given),
 *  with the token's symbol/decimals for operator-facing messages. */
export async function fetchErc20Funding(
  rpcUrl: string,
  token: string,
  owner: string,
  spender?: string,
): Promise<Erc20Funding> {
  const c = client(rpcUrl);
  const address = token as Address;
  const [balance, symbol, decimals, allowance] = await Promise.all([
    c.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [owner as Address] }),
    c.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => "token"),
    c.readContract({ address, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
    spender === undefined
      ? Promise.resolve(undefined)
      : c.readContract({
          address,
          abi: erc20Abi,
          functionName: "allowance",
          args: [owner as Address, spender as Address],
        }),
  ]);
  return { balance, allowance, symbol, decimals: Number(decimals) };
}

# 0006 — Multi-chain RPC as an admin-configurable registry; Robinhood Chain's arrival-ordering drives Phase 2 deployment geography over gas-bidding

Date: 2026-08-21
Status: accepted
Produced by: multi-agent expert panel (CTO/CPO orchestration, `/goal`) — see
[`docs/execution-architecture.md`](../execution-architecture.md) for the full
roadmap this ADR is one piece of, and the panel's underlying position papers.

## Context

Config today exposes exactly one RPC_URL/RPC_WS_URL/ROBINHOOD_CHAIN_ID, which doesn't scale to multiple chains or per-chain RPC failover, and the owner explicitly asked for 'custom RPC' support. Separately, the Low-Latency lane verified against docs.robinhood.com/chain that Robinhood Chain uses single-sequencer, strictly arrival-time (not fee-based) ordering, sequencer located in AWS us-east-2 (Ohio), with third-party latency measurements showing a 1–2 block edge from geography alone. The Risk/SRE lane independently verified Robinhood Chain is an Arbitrum Orbit L2 with two-phase finality (fast soft-confirmation, ~13 minute hard L1 finality) and pre-batch reorgs are possible. These two findings are complementary, not conflicting, and together they invert the standard 'gas war' playbook the owner's directive implicitly assumed.

## Decision

(a) Introduce an rpcEndpoints table + RpcPool abstraction, admin-configurable per chain via the UI (not boot-time env vars) — this ships in Phase 0 as a pure read-only extension and directly satisfies the owner's 'custom RPC' ask with zero execution risk. Keep RPC_URL/ROBINHOOD_CHAIN_ID as a backward-compatible default for the one chain that exists today. (b) For Robinhood Chain specifically: reject an aggressive EIP-1559 priority-fee ladder as the primary execution lever — verified, it does not move queue position on this chain. Treat apps/executor's physical deployment location as the primary lever instead: recommend colocating the Phase 2 executor process in AWS us-east-2 near the sequencer, and use quorum multi-provider submission (2–3 providers plus a direct RPC connection, first-ack-wins) to hedge provider-side path jitter to that single sequencer — explicitly not to create independent chances at independent orderings, which this chain does not offer. (c) Track a two-phase PROVISIONAL_SUCCESS → CONFIRMED status on executionAttempts using each chain's own documented safe-confirmation depth (Robinhood Chain's ~13-minute L1 batch post, specifically — never reused for other chains without separately verifying their own depth).

## Consequences

A chain-config-driven gas model (fcfs-arrival | eip1559 | legacy) still gets built in packages/core for portability to mainnet/Base/Polygon, but the owner must be told explicitly, in plain language, that outbidding bots is not the fix for the stated pain on Robinhood Chain — geography and pre-computed calldata are. Ohio colocation requires a new ops runbook: a secure tunnel (Wireguard/SSH, never a publicly exposed Postgres) from the remote executor to the home Compose stack's database.

## Alternatives rejected

Self-hosted full node for Robinhood Chain as the default execution RPC — rejected; there is no independent mempool to gain an edge over on a single-sequencer arrival-ordered chain, so it buys read-speed, not queue position, at meaningfully higher single-operator ops burden. Flashbots-style private relay as a default anywhere — rejected; no comparable relay/mempool concept exists on Robinhood Chain, and on mainnet it typically adds inclusion latency that costs more races than it wins; scoped instead to an opt-in, mainnet-only Phase 3 toggle.

# 0007 — Sentiment/signal pipeline as a structurally separate, advisory-only bounded context

Date: 2026-08-21
Status: accepted
Produced by: multi-agent expert panel (CTO/CPO orchestration, `/goal`) — see
[`docs/execution-architecture.md`](../execution-architecture.md) for the full
roadmap this ADR is one piece of, and the panel's underlying position papers.

## Context

The Data/Sentiment lane verified against docs.x.com and X's own Feb 6 2026 developer announcement that the free API tier was retired entirely and legacy subscription tiers are closed to new signups; current access is metered pay-per-use (~$0.005/post read, no subscription available), with only a narrow 'owned reads' carve-out that doesn't cover watching other accounts. The owner's literal premise — 'use X.com OAuth for not new cost' — was true before Feb 2026 and is not true as of Aug 2026; it must be corrected, not silently honored or silently dropped. Separately, the CTO lane proposed packages/sentiment and the Data/Sentiment lane proposed packages/signals with a more detailed schema (a confidence enum distinct from projects.confidence, and an explicit hard non-write boundary) — a naming and design-depth conflict.

## Decision

Adopt the Data/Sentiment lane's naming and schema as authoritative: a new package packages/signals (not packages/sentiment) plus a new providers/x OAuth adapter, reusing the existing providers/evidence pattern exactly as OpenSea and on-chain sources do today. The signals table carries its own confidence enum (corroborated | single-source | unverified | stale), deliberately distinct from projects.confidence, because one answers 'is this identity/schedule fact true' and the other answers 'how much do I trust this hype/risk read' — conflating them would let a loud Twitter mob raise a project's identity confidence, which must never happen. Hard boundary, enforced at the package-dependency level: nothing in packages/signals may write to projects.confidence, projects.lifecycleStatus, or eligibilityChecks.status; nothing in packages/execution may read signals as an auto-arm trigger, in any phase. Re-scope 'not new cost' to 'no recurring subscription, a small metered spend the owner explicitly caps' — this must be said to the owner directly, not quietly substituted. Enforce the cap at two independent layers: X's own billing dashboard (verify this control exists before relying on it) and an application-level circuit breaker (load-bearing regardless of the first). Ship Phase 0 as read-only, manually-triggered per-drop (never a background poller across the whole calendar) until live X rate-limit response headers are confirmed at implementation time to support broader polling.

## Consequences

If the owner rejects any X spend at all, the documented fallback is manual-watchlist-only polling of ~20–40 known accounts, on-chain-only corroboration (mint velocity, holder concentration) as the sole hype proxy, and free community scam/rug-pull address lists — with the UI showing an explicit 'NO SIGNAL — X source disabled' state, never a stale or fabricated score. Signal badges get their own component and color tokens (cyan for hype/informational, magenta for scam/bot-cluster risk), never StatusChip, so a hype badge can never be misread as an eligibility win.

## Alternatives rejected

Paid X subscription tiers (legacy Basic/Pro/Enterprise) — rejected, closed to new signups or absurdly priced for a single operator. Third-party sentiment APIs (LunarCrush, Santiment) — rejected, still a recurring subscription plus a second vendor credential, no real improvement on the cost goal. Unofficial scraping (Nitter-style) — rejected outright, ToS-violating, fragile, and inconsistent with a product whose identity is explainable, provenance-tracked data.

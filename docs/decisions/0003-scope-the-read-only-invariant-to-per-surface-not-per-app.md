# 0003 — Scope the read-only invariant to per-surface, not per-app

Date: 2026-08-21
Status: accepted
Produced by: multi-agent expert panel (CTO/CPO orchestration, `/goal`) — see
[`docs/execution-architecture.md`](../execution-architecture.md) for the full
roadmap this ADR is one piece of, and the panel's underlying position papers.

## Context

README L7, PRD.md L19, and DESIGN.md's footer tagline currently assert an absolute, whole-product claim: the application never holds a private key, never signs, never broadcasts a mint. The owner's directive requires an opt-in Execution capability that can, when explicitly armed, hold a scoped session key and broadcast a transaction. Leaving the absolute claim in place becomes a user-facing falsehood the moment ANY code path can sign — including Phase 1's zero-custody browser-signed flow, not just Phase 2's delegated key.

## Decision

Rewrite the invariant as a per-surface claim, effective the moment Phase 1 ships (not deferred to Phase 2): 'Discovery, eligibility-checking, and sentiment/signal evaluation are always read-only — no code path there ever holds a private key. Execution is a separate, opt-in, step-up-authenticated surface: every mint plan is armed by an authenticated operator under a capped, revocable, per-collection delegation. The system never holds unconstrained signing power over the owner's funds, and the hardware wallet is never an automated signer.' Update README L7, PRD.md L19/L34, and DESIGN.md's 'read-only radar' footer tagline (e.g. to 'tracking: read-only · execution: opt-in') in the same change that ships Phase 1, not after.

## Consequences

A new top-level nav section 'Execution' is added, magenta-accented per DESIGN.md's existing 'rare/exceptional' token role, gated behind Better Auth step-up re-auth. Any future contributor or the owner six months from now reads an honest, narrower claim instead of a stale absolute one. Docs (README/PRD/DESIGN.md) and this ADR must be updated together whenever Execution's scope changes — drift here is a trust bug, not a documentation nit.

## Alternatives rejected

Leaving the absolute claim in place and treating Execution as an undocumented exception — rejected outright as dishonest to the owner and to the product's own stated identity. Renaming the whole product away from 'Radar' — rejected; ~90% of the product remains genuinely read-only and the existing brand/design equity is real.

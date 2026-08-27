# 0009 — Mint-race competitive execution recommendations (Phase 1 scope, Phase 2 boundary)

Date: 2026-08-22
Status: accepted
Produced by: CTO synthesis of chain-specifics / bot-landscape / speed-engineering /
compliance-risk / opensea-mechanics research, revised against three independent
adversarial panel reviews (phase1-feasibility, realism-check, compliance-safety).
See [`docs/execution-architecture.md`](../execution-architecture.md) for the
phase roadmap this document assumes, and ADR 0004, 0005, 0006, 0008 for the
custody, pipeline, RPC-registry, and rollout-gate decisions it builds on.

**Implementation status, added 2026-08-22 same day (fifteenth/sixteenth
passes — see `docs/execution-architecture.md` for the full account of
each):** P1, P2, P3, P5, and P4 are all **shipped and live-verified**
against real infrastructure (the real Robinhood Chain public RPC, a real
Postgres instance) — not just recommended. P4 shipped in a form corrected
from this document's own text below: §2's P4 description assumes
pre-building "at a single fixed, drift-corrected offset" before a
*predicted* stage-open time, but implementing it required first reading
`apps/worker/src/index.ts`, which showed this system's execution pass
polls on a fixed interval with no stage-time prediction mechanism at
all — that framing doesn't fit the real architecture. What actually
shipped: pre-build triggered at **arm time** (a real trigger this system
already has) instead, cached with a TTL, consumed at claim time if fresh.
The quota guardrail, the TTL/staleness handling, and the "never gates the
real due-to-fire build" property below are all unchanged from what this
document specifies. P6 (Ohio colocation) remains unshipped — it needs the
owner's own AWS account, the same category of blocker as Phase 2/3.
P7/P8 remain low-priority/already-correct-as-is, not implemented as
separate work.

**Provenance note.** The five research documents cited by name throughout
this ADR (chain-specifics, bot-landscape, speed-engineering, compliance-risk,
opensea-mechanics) are inputs external to this repository — they do not
exist as files here and were not re-audited line-by-line in this revision.
Every claim sourced *only* to one of them is labeled as such. Every claim
that also cites a `packages/`, `apps/`, or `docs/decisions/` path was
verified against that file directly, in this revision, by at least one of
the three adversarial reviews this document was revised against, and in most
cases cross-checked a second time while producing this final version.

---

## 1. Executive summary

Robinhood Chain (4663) is a single-sequencer, strict-arrival-time chain with
no public mempool and no fee-based reordering — a fact this revision
verified independently against `docs.robinhood.com/chain` and third-party
latency measurement, not just inherited from this repo's own prior ADR. That
collapses the competitive surface to two things: raw latency to the Ohio
sequencer, and how early calldata is ready. Phase 1's hard boundary —
every real transaction is signed by a human clicking a browser-wallet
popup, because the server never holds a spend-capable key
(`packages/signing/src/index.ts:45-49`) — is structural, not a bug, and it
means **Phase 1 cannot win a millisecond-class race against a genuinely
pre-signed, session-keyed, Ohio-colocated competitor; no legal amount of
Phase-1 engineering changes that.** What Phase 1 *can* do, and what this
document recommends building, is close every avoidable gap on the
prepare/simulate/notify path so the system is fast and ready the instant a
human click becomes the only remaining variable — while being honest that
the realistic field it competes against is a genuine mix of casual human
minters *and* a small but real population of already-circulating,
chain-aware scripts, not a comfortably thin field of humans alone. One
Section-1 item (speculative transaction pre-building) is revised in this
version to cap OpenSea write-API call volume against a documented 30-req/hour
quota, and every Section-1 item now carries forward, rather than implicitly
sets aside, the project's own still-open question about OpenSea ToS coverage
of automated mint execution.

---

## 2. Buildable now — Phase 1, no new custody

**Standing caveat over this entire section**, not just the item it's most
relevant to: `docs/execution-architecture.md:1071` records, as the project's
own current and still-open position, that *"OpenSea ToS coverage of
automated mint execution specifically"* is unresolved — "unresolved by two
independent panelists and by this session's own follow-up read of
`opensea.io/tos`." The project's rollout gate (ADR 0008) correctly requires
the owner to accept that risk explicitly before Phase 2's real-money gate
opens. That gate is scoped to Phase 2's *automated broadcast*, but the
underlying ToS question is about the pattern of automated interaction with
OpenSea's API at all — and Phase 1 already does that (every `buildTransaction`
call today is machine-initiated API use, just followed by a human wallet
click rather than a hand-typed browser session). None of the items below
change that base exposure merely by staying inside Phase 1 custody; only P4
below meaningfully changes call *volume or pattern* against OpenSea's write
endpoint, and it is scoped accordingly. The rest are latency/read-path
changes that change how fast the system asks OpenSea for something it was
already going to ask for, not what or how often.

Items are ordered by priority (confidence × leverage, not the internal
numbering from the working draft this ADR replaces).

### P1 — Parallelize the two simulate calls
**Effort: trivial (one-line change). Impact: high-confidence, mechanical.**

`simulateTransaction` (`packages/providers/src/chain/simulate.ts:41-53`)
awaits `client.call()` then `client.estimateGas()` sequentially. Both are
independent reads against the same state — run them with `Promise.all`.
This halves the mandatory-simulation stage's wall time for free, with zero
change to safety semantics (both must still succeed for `ok:true`, and ADR
0005's "simulate is never bypassable" is untouched). No external citation
is needed for this one; it is self-evident from the code and needs none.
This is the single most certain item in this document.

### P2 — Wire the dormant RpcPool health/ranking system into the hot path
**Effort: medium (new scheduled check + two call-site swaps). Impact:
architecturally correct and low-risk; real-world win-rate impact is
plausible, not measured.**

`rankRpcEndpoints` (`packages/core/src/execution.ts:127`) and the RPC
repository's `recordRpcEndpointHealth` (`packages/db/src/repositories/rpc.ts:58`
— corrected in this revision; the working draft misnamed this
`updateRpcEndpointHealth`, a function that does not exist anywhere in the
repo) already implement the ADR-0006 admin-configurable RPC registry, and
the admin UI (`apps/web/src/app/admin/execution/page.tsx`) already exposes
it. Nothing calls any of it: `apps/worker/src/workers/chain.ts:33/42` and
`apps/worker/src/workers/execution.ts:62/135` read the single legacy
`config.RPC_URL` (`packages/config/src/index.ts:54`) directly, and no
worker ever calls `recordRpcEndpointHealth`, so every `healthStatus` row is
permanently stale. This is a confirmed gap, not a hypothesis.

- Add a scheduled health-check pass (new function in a maintenance/`rpc.ts`
  worker) that calls `getGasSnapshot` (`packages/providers/src/chain/gas.ts`)
  against every enabled chain-4663 endpoint every 30–60s, classifies via
  `classifyLatency`, and persists via `recordRpcEndpointHealth`.
- In `simulateTransaction` and `ChainRadar` (`packages/providers/src/chain/rpc.ts`),
  replace the hardcoded `config.RPC_URL` with `rankRpcEndpoints(...)[0].url`,
  falling back to `RPC_URL` when the table is empty.
- **Calibration note added in this revision**: label this "highest
  confidence, lowest risk," not "highest value." Its real win-rate impact
  depends on how much latency variance actually exists between candidate
  RPC providers reaching the *same* Ohio sequencer — a quantity nothing in
  this document's research measured. If candidate endpoints are all
  comparably fast, this buys architecture correctness and resilience
  (automatic failover away from a degraded endpoint) more than raw speed.
  Ship it for the correctness and resilience case; don't promise a specific
  latency win to the owner without measuring it post-deploy.

### P3 — Auto-surface the sign prompt the instant a plan is ready, don't wait for a page refresh
**Effort: small–medium (wire existing SSE into the admin execution page).
Impact: plausibly the highest-leverage Phase-1 item, because it targets the
largest unaddressed term in the critical path — but this is a reasoned bet,
not a measured one.**

The dominant term in "stage goes live → owner has a signed transaction" is
almost certainly human reaction time (seconds), not network RTT
(milliseconds) — which is precisely why this item outranks pure latency
work in priority, even though it's the least "researched" item in this
document. SSE plumbing already exists in this repo (`apps/web/src/app/api/v1/events/route.ts`,
`components/sse.tsx`), but a direct check in this revision confirms it is
**not currently wired into the admin execution page** — `sse.tsx` is
imported nowhere in `apps/web/src`, and `admin/execution/page.tsx` is a
server component with no client-side subscription. This is a confirmed gap,
not the "unverified, treat as maybe" hedge the working draft carried — a
direct grep resolves it.

- Have the admin execution surface subscribe to the live event stream and
  auto-render the wagmi sign prompt the instant
  `outcome.stage === "ready_for_browser_signature"` lands
  (`apps/worker/src/workers/execution.ts:160-171` is where that state is
  written), rather than requiring the owner to already be on/refreshing
  that page.
- Pair with the existing Telegram outbox alert firing at the same moment.
- **What this item actually is, stated plainly**: this is standard
  "push, don't poll" product/UX practice applied to a real, verified code
  gap — not a discovery specific to NFT-bot research. Don't oversell its
  citation pedigree; don't undersell its value either. There is no
  production telemetry yet on how much of total time-to-click is spent on
  notification latency versus the owner's own reaction time once notified,
  so treat the "highest-leverage" ranking as the team's best current bet,
  revisit once real drop attempts produce data.
- **Guardrail, added in this revision (compliance-safety review, finding
  4)**: any future iteration of this item may reduce time-to-visible-prompt
  and nothing else. It must never add a control surface that submits,
  pre-approves, or confirms a transaction outside the wallet's own UI — a
  Telegram-reply "approve," a one-tap skip-the-popup shortcut, or anything
  similar is a custody-model change, not a UX tweak, and belongs in a
  revision of ADR 0008's gate sequence with the same scrutiny Phase 2 gets,
  never shipped as an incremental follow-up to this item.

### P4 — Pre-build calldata off the hot path, capped against the OpenSea write quota
**Effort: medium–high (needs a quota-aware guard and a confirmed-readiness
gate, not just a cache). Impact: real RTT removal on the common path, but
bounded and must ship with the guardrails below — this item is the one
piece of Section 1 substantively changed by adversarial review.**

Today, `apps/worker/src/workers/execution.ts:105` calls
`adapter.buildTransaction()` — a `POST /api/v2/drops/{slug}/mint` call to
OpenSea (`packages/execution/src/adapters.ts:29-33`) — only after a plan is
claimed as due-to-fire, immediately before the mandatory simulate call.
That's two sequential network round-trips stacked on the critical path
between "stage goes live" and "owner sees a sign prompt." Pre-building
calldata before that moment is a real latency win. But the working draft's
version of this item — "pre-call at T-30s, rebuild if not fired within N
seconds" — is unbounded, and this revision rejects shipping it in that
form:

- **The risk (compliance-safety review, finding 1)**: this endpoint is
  write-scoped, and ADR 0004 documents its own quota for exactly this key
  type — `30/h write` (ADR 0004, citing OpenSea's instant-key issuance
  endpoint). A speculative "pre-build, and rebuild on staleness" loop, run
  across every armed plan or retried whenever a predicted window misses,
  can burn a meaningful share of a 30-request/hour budget on builds that
  never fire — starving the one build call that actually matters, at the
  moment it's needed. That is the opposite of the latency win this item is
  chasing, and it is also the one Section-1 change that meaningfully
  increases automated call volume/pattern against OpenSea's write API while
  the base ToS-coverage question above remains open.
- **The fix, required before shipping this item**: cap speculative
  pre-builds explicitly. At most one speculative build per armed plan per
  stage window — not a retry loop — scheduled at a single fixed,
  drift-corrected offset (using P6's clock-offset correction, tuned
  empirically rather than a guessed "T-30s"), with a short TTL and at most
  one rebuild on TTL expiry, never an unbounded "rebuild until fired" loop.
  Track a rolling-hour count of write-endpoint calls (a small counter next
  to the RPC health table P2 already introduces is sufficient) and hard-stop
  speculative pre-builds — falling back to the current synchronous,
  at-fire-time build — once the rolling-hour count approaches roughly 80%
  of the documented 30/h ceiling. The real, due-to-fire build always wins
  budget over a speculative one.
- The mandatory simulate stage (ADR 0005, "never bypassable") is unchanged
  by this item in any form — pre-building calldata does not skip
  simulation, it only removes the OpenSea RTT that currently precedes it.

### P5 — Clock calibration for stage-timing precision
**Effort: small–medium. Impact: real but secondary — standard
distributed-systems hygiene, not a specialized bot technique, and bounded
by the same "human click dominates" ceiling that makes P3 the higher
priority.**

Add a periodic drift check — compare `Date.now()` against the RPC's latest
block timestamp (or the sequencer feed, per `docs.robinhood.com/chain`) —
and store an offset used wherever "time until stage open" is computed. This
is decades-old NTP-style offset tracking applied to a mint-timing context,
not a discovery unique to mint-bot tooling; the working draft's citation of
a specific `dhasap/nft-mint-agent` flag name (`--early-ms`) could not be
confirmed against the tool's current documentation in this revision, so it
is dropped rather than repeated unverified. The technique stands on its own
merits regardless of that citation. Rank this below P3: shaving hundreds of
milliseconds off scheduling precision matters less than closing the
multi-second gap between "worker knows" and "owner sees a prompt."

### P6 — Ohio colocation of the worker process, scoped honestly, with the secure-tunnel requirement restored
**Effort: medium (infra deploy + a new ops runbook). Impact: real but
narrow — prepare/simulate/notify only, magnitude unmeasured, likely
secondary to P3.**

Chain-specifics research puts the Ohio-vs-distant gap at roughly 3ms vs
90–200ms — a figure this revision independently verified against
`docs.robinhood.com/chain`'s own stated arrival-ordering rule and
third-party latency measurement (Glassnode: ~3ms Ohio vs ~140ms Tokyo vs
~200ms Sydney, ~100ms block time), not merely inherited from this repo's
own ADR 0006 citing the same primary source. Deploying the worker process
(the one calling `simulateTransaction` and `ChainRadar`) to AWS us-east-2 is
buildable now via `infra/docker/app.Dockerfile` / `compose.prod.yaml`. Two
things must be stated precisely, both restored in this revision:

- **The scope boundary (unchanged from the working draft, confirmed
  correct by review)**: the final broadcast of the signed transaction is
  done by the owner's own wallet extension in their browser, using whatever
  RPC that wallet is configured with — not something the worker controls in
  Phase 1 (`packages/execution/src/pipeline.ts:6-8`: *"Nothing here signs
  or broadcasts; the only place a transaction can be signed is the owner's
  own browser wallet"* — corrected citation; the working draft misattributed
  this quote to `packages/signing/src/index.ts`, whose own docstring makes
  an adjacent but different claim about being the sole signing chokepoint).
  Ohio colocation buys faster prepare/simulate/notify. It does **not** buy
  faster broadcast-to-sequencer. Don't oversell this line item to the owner.
- **The operational requirement (dropped from the working draft, restored
  here — compliance-safety review, finding 3)**: ADR 0006's own
  Consequences section states, verbatim, that "Ohio colocation requires a
  new ops runbook: a secure tunnel (Wireguard/SSH, never a publicly exposed
  Postgres) from the remote executor to the home Compose stack's database."
  This is a precondition for shipping P6 at all, not optional hardening —
  standing up a remote worker with a naively internet-exposed DB connection
  is the exact failure mode ADR 0006 named.

### P7 — Direct on-chain corroboration for public-stage timing
**Effort: small. Impact: low — a resilience fallback, not a speed lever.**

`ChainRadar` already watches mint events on-chain. For public stages only
(no proof/signature required, confirmed enforceable purely on-chain per
SeaDrop), add a lightweight direct read of the SeaDrop public-drop struct
as a cross-check against OpenSea's drop-detail polling cadence, similar in
spirit to `morsyxbt/nft-public-mint`'s approach — a small, real, low-adoption
tool, cited here as evidence this is *possible*, not evidence it moves
win-rate. This gives a fallback if OpenSea's API is slow or degraded right
at stage-open, for exactly the stage type where on-chain derivation is
legitimate. Do **not** extend this to allowlist/signed stages — those need
OpenSea's own signature/proof and cannot be legitimately derived on-chain.

### P8 — Leave `gas.ts` exactly as scoped
**Effort: none (a restraint decision, not a build item).**

`packages/providers/src/chain/gas.ts`'s docstring already states its
purpose correctly: "This is a read — never a transaction, never a spend
decision on its own." Given FIFO-arrival ordering, that is exactly right
and should stay a health/readiness signal, not evolve into a bidding
engine. See §4.

---

## 3. Requires Phase 2 — delegated custody

Each item below is real and load-bearing in the source research, and each
is architecturally impossible in Phase 1 for the same root reason: the
server never holds a key or a signed payload, by design
(`packages/signing/src/index.ts:45-49`).

- **Pre-signed transaction fired at a precomputed on-chain timestamp with
  zero human latency.** The single biggest lever in the bot-landscape and
  speed-engineering research. Requires a signer that can produce and hold a
  valid signature before the trigger and fire it without a click at trigger
  time — exactly what ADR 0004's Zodiac-Roles-scoped session key is
  designed for, and exactly what `assertSignable` currently blocks for
  every scheme except `browser_wallet`.
- **Automated retry/re-fire on non-inclusion.** Robinhood Chain's FIFO
  model means this is not "bump gas and resubmit" — that is meaningless
  here — it's "have a session key fire a fresh prepared tx immediately on
  detecting non-inclusion." Phase 1 cannot do this because every attempt
  needs a fresh browser popup and click, categorically slower than the
  window a competitor operates in.
- **Broadcast-hop colocation.** As noted in P6, the actual signed-tx
  broadcast happens from the owner's wallet, wherever that runs — not from
  HoodMint's infrastructure. Only a Phase-2 session-key signer running
  server-side (per ADR 0004/0006, in AWS us-east-2) actually captures the
  ~3ms-vs-90–200ms Ohio edge.
- **Multi-endpoint fan-out of the *signed* transaction** (racing 2–3
  providers plus a direct RPC connection, first-ack-wins — literally what
  ADR 0006(b) already specifies for Phase 2). Phase 1 has nothing to fan
  out, because it never sees the signed bytes.
- **Sub-100ms-precision clock-triggered firing.** Phase 1's best case (P5 +
  P3) is "notify and auto-prompt within roughly a second of detection."
  Only a Phase 2 signer removes the human step entirely and can target true
  sub-block precision.

None of this is a knock on Phase 1 — it is the accurate statement of what
delegated custody buys, which ADR 0004/0008's own gate sequence (WebAuthn
step-up, layered kill switch, phone-executable Ledger revoke, monthly
drills) already treats as a deliberate, non-trivial threshold to cross, not
a default. Phase 2's real-money gate additionally cannot open until the
owner has knowingly accepted the open OpenSea ToS question referenced in §2
— that acceptance is required for Phase 2 specifically because Phase 2 adds
custody risk on top of the same open question, not because the question
itself only exists at Phase 2.

---

## 4. Explicitly rejected

- **Multi-wallet/Sybil evasion** (antidetect browsers, proxy/mobile-IP
  rotation, aged wallets). Reject outright: compliance-risk research ties
  this pattern to actual documented consequences, it is structurally
  pointless against on-chain `maxPerWallet` caps anyway, and it directly
  contradicts this project's single-owner, human-arms-it design.
- **Reverse-engineering OpenSea's internal/undocumented session-auth** to
  defeat server-signed or encrypted-allowlist stages. Both opensea-mechanics
  and compliance-risk research flag this as the one thing that crosses from
  "authorized API use" into ToS-risk territory. It is also pointless
  engineering effort: those stage types are unbypassable by design
  regardless of cleverness. Keep the published, wallet-JWT-authenticated
  eligibility flow `eligibility.ts` already implements.
- **Headless-browser UI automation against opensea.io.** Reject — no
  demonstrated speed/access advantage over the documented API path already
  in use, and it is the exact pattern OpenSea's ToS targets.
- **Flashbots-style private bundles / MEV-protect RPC** as an offensive
  tool for Robinhood Chain. Reject as a priority: there is no public
  mempool and no fee-based reordering on this chain — there is nothing to
  hide a transaction from. This would solve a mempool-sniping problem that
  provably doesn't exist on the chain this system targets.
- **Gas-price overbidding / auto-escalating priority-fee logic.** Reject
  for Robinhood Chain specifically — raising fee does not reorder pending
  transactions here. Porting mainnet-focused "current gas + 10 gwei" / RBF
  heuristics would be pure wasted gas on this chain. Keep `gas.ts` exactly
  as scoped today (P8).
- **A server-side "silent retry with a cached signature" shortcut** to
  route around the Phase-1 human click. Reject — this is not a speed
  optimization, it is a custody-model regression disguised as one. It would
  require either caching a signed payload the server was never supposed to
  see, or standing pre-authorization from the wallet — exactly the
  controlled, hardware-gated expansion ADR 0004/0008 already scope to Phase
  2. Any version of this shipped without that machinery is a security hole,
  not a feature.
- **A general Ethereum-mainnet-style "gas war" dashboard/bidding
  assistant.** Reject as misallocated effort — the literature it would be
  modeled on targets a market structure this chain does not have.

---

## 5. Honest bottom line on realistic win-rate

Against a hypothetical genuinely dedicated Phase-2-grade competitor
(pre-signed, session-keyed, Ohio-colocated), **Phase 1 cannot win a
millisecond-class FCFS race, and no amount of legal Phase-1 engineering
changes that** — the human-click floor is structural, not a bug to
optimize away. This is not softened by anything in this revision.

What this revision does change is how confidently the field Phase 1
actually competes in should be described. The working draft's framing —
"the realistic opponent is another human clicking Mint in the OpenSea UI,
not an Ohio-colocated HFT rig" — does not survive adversarial review intact.
It is true that bot-landscape research finds no *dominant, branded*
mint-racing product (the tools identified are small, low-star, hobbyist
projects, not a commercial actor). But at least two of those tools —
`dhasap/nft-mint-agent` and `morsyxbt/nft-public-mint` — already publicly
target Robinhood Chain specifically, with chain-aware pre-signing and
multi-RPC fan-out behavior, and this chain is young enough (mainnet since
early July 2026, roughly seven weeks old at time of writing) and already
seeing real drop volume (a single drop reportedly moving over a million
dollars in under an hour) that "a thin field of humans" understates the
realistic mix. The corrected claim: the field is genuinely mixed — many
drops will in fact be decided against other unautomated humans, and some
fraction, weighted toward higher-profile or higher-value drops, will
include already-circulating, chain-aware scripts. There is no telemetry
from this system's own drop attempts yet to size that mix precisely, and
none of the recommendations in §2 change based on this correction — they
remain the right things to build regardless of exactly how thin the field
is. What changes is the confidence with which "fast and ready plausibly
wins more often than the gas-war mental model suggests" should be stated to
the owner: as a reasoned bet worth pursuing, not as a measured conclusion.

Recommend framing this to the owner in two parts, both stated plainly
rather than implied: (1) Phase 1 is not competitive with a determined,
Phase-2-caliber bot operator, and ADR 0004/0008's own gate sequence already
treats that gap as the reason Phase 2 exists — closing P1 through P8 above
narrows the *avoidable* gap, it does not close the structural one; and
(2) separately from the custody question, OpenSea's ToS coverage of
automated mint execution generally is an open question this project has
not resolved for itself, already logged in `docs/execution-architecture.md`
and gated on explicit owner acceptance before Phase 2's real-money step —
building §2's items does not require re-opening that question, but it also
does not resolve it, and the owner should hear that framed as still-open
rather than quietly inherited as "fine because it's Phase 1."

**What is verified by direct code/doc read in this revision** (high
confidence, restated from the underlying working draft and independently
re-confirmed): the RpcPool dormancy in P2, the sequential `buildTransaction`
→ simulate ordering in P4, the sequential (not parallel) simulate calls in
P1, the single `config.RPC_URL` usage across `chain.ts`/`execution.ts`, the
SSE-not-wired gap in P3, the ADR 0004 write-quota figure behind P4's cap,
and the ADR 0006 secure-tunnel requirement restored in P6.

**What remains plausible but unmeasured**: P2 and P6's actual latency
win in production (no endpoint-to-endpoint measurement exists yet), P3's
"highest-leverage" ranking (reasoned, not measured against real
time-to-click data), and the precise human-vs-script mix in the realistic
competitive field described above. None of these should be presented to
the owner with more confidence than "mechanism is sound, magnitude is
unmeasured until this ships and produces real drop-attempt data."

**Files referenced (verified by direct read across the original synthesis
and the three adversarial reviews this document was revised against):**
`packages/providers/src/chain/gas.ts`, `packages/providers/src/chain/rpc.ts`,
`packages/providers/src/chain/simulate.ts`, `packages/execution/src/pipeline.ts`,
`packages/execution/src/adapters.ts`, `packages/signing/src/index.ts`,
`packages/core/src/execution.ts`, `packages/db/src/repositories/rpc.ts`,
`packages/config/src/index.ts`, `apps/worker/src/workers/eligibility.ts`,
`apps/worker/src/workers/execution.ts`, `apps/worker/src/workers/chain.ts`,
`apps/web/src/app/admin/execution/page.tsx`, `apps/web/src/components/sse.tsx`,
`docs/execution-architecture.md`, `docs/decisions/0004-execution-custody-model.md`,
`docs/decisions/0005-execution-package-process-boundaries-and-data-model.md`,
`docs/decisions/0006-multi-chain-rpc-registry-and-arrival-ordering.md`,
`docs/decisions/0008-rollout-gate-sequence-and-layered-kill-switch-for-live-execution.md`.

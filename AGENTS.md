# HoodMint Radar implementation instructions

Read `PRD.md` completely before changing code. The PRD is the product and engineering contract. If an ambiguity materially affects security, data truth, or UX, record the assumption in `docs/decisions/` and choose the safest reversible implementation.

Use GPT-5.6 Sol for this implementation. Start by inspecting the repository and producing a short gap list against PRD sections 8, 14, 15, 16, and 18. Then implement the smallest complete vertical slice; do not stop after scaffolding or leave the repository in a non-runnable state.

Non-negotiable rules:

- Never request, store, or log wallet private keys or seed phrases.
- Never report public-stage eligibility as a whitelist hit.
- External JSON is `unknown` until Zod parsing succeeds.
- Use `bigint`/decimal strings for wei, supply, block numbers, and quantities.
- Keep provider evidence/provenance and visibly label stale or uncertain claims.
- Secret fields are encrypted at rest, write-only after save, server-only, and redacted everywhere.
- All background work is idempotent and safe under at-least-once execution.
- React Server Components are default; client components must justify interactivity.
- Do not replace the specified stack without an ADR explaining measurable benefit and migration cost.
- Use generated reviewed migrations; never production `drizzle-kit push`.
- Use `apply_patch` for hand edits, preserve unrelated user changes, and make intentional small commits.

Before claiming completion, run the full merge-gate commands from PRD section 15 plus a Docker clean-start smoke test. Report concrete command output, remaining gaps, and any acceptance criterion not proven. Do not claim live OpenSea eligibility without an authenticated test result; use fixtures when credentials are absent.

The root Python files are a reference prototype. Move them unchanged into `reference-python-mvp/` during the TypeScript scaffold and preserve them until equivalent tests exist.

## Design System

Always read `DESIGN.md` before making any visual or UI decisions. Fonts, color roles (base/ink/acid/cyan/magenta), spacing, motion, responsive shells, and dark/light persistence are defined there. Do not deviate without an explicit decision in `docs/decisions/`. Dark is the default theme; light is a first-class second map applied through `applyTheme`.

## Local ports

Host-published local services use the contiguous sequence starting at 3960 (web 3960, Postgres 3961, Valkey 3962, worker health 3963). Start with `scripts/start-dev.sh`; stop with `scripts/stop-dev.sh`. Production posture: `scripts/start-prod.sh` / `scripts/stop-prod.sh`. Unconfigured env is handled by `scripts/env-setup.sh` (see `docs/ops-setup.md`). Do not revert defaults to 3000/5432/6379.

## Anti-patterns to avoid

1. Never aggregate tracked-wallet eligibility across every phase and display it beside one current/next phase. Every decision-card eligibility lookup and WL filter must require the exact `{ projectId, stageId }`; a hit from an ended phase is not a hit for the displayed mint.
2. Every dedicated database client must close on initialization/subscription failure before a reconnect is scheduled. Reconnect loops that abandon failed clients can silently exhaust PostgreSQL's connection ceiling.

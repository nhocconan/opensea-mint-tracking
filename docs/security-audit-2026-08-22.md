# Security audit — execution surface (2026-08-22, updated same day)

Scope: everything added for mint execution (packages/signing, packages/execution,
packages/db execution/signals repos + schema, apps/worker/src/workers/execution.ts,
apps/web/src/app/admin/execution/*, the execution-related server actions, RBAC,
the OpenSea mint-API client, and pre-flight simulation). Manual OWASP Top 10
review, plus — added later the same day, once network access proved reliable
in this environment — real automated tooling: `gitleaks` (installed via
`brew install gitleaks`) and `pnpm audit`.

## Findings

| Severity | Area | Finding | Fix |
|---|---|---|---|
| Medium | A10 SSRF | Admin-supplied RPC endpoint URLs (`createRpcEndpointAction`) had no protection against pointing the worker's real outbound RPC calls at a cloud instance-metadata service (169.254.169.254 / metadata.google.internal / the AWS IMDSv2 IPv6 address) — a compromised/phished admin session or a fat-fingered URL could turn the worker into an SSRF pivot into cloud credentials. Private/LAN addresses are intentionally still allowed (self-hosted RPC nodes are a legitimate target per ADR 0006), so the existing webhook SSRF guard (`packages/notifications/src/ssrf.ts`, which blocks all private ranges) doesn't directly apply. | **Fixed**: new `assertSafeRpcUrl` (`packages/providers/src/chain/rpc-url.ts`, 8 tests) blocks only the known metadata hostnames/IPs, resolving DNS names the same way the webhook guard does to catch a rebinding-style hostname. Wired into `createRpcEndpointAction` for both `httpUrl` and `wsUrl`. |
| Low | A04 Insecure Design | `createMintPlanAction`'s quantity handling: `Math.max(1, Math.floor(input.quantity))` — `Math.max` with `NaN` returns `NaN`, so a missing/non-numeric quantity field would have attempted to insert a `NaN` quantity rather than failing with a clear message. | **Fixed**: explicit `Number.isFinite` check returns a clear `ActionState` error before reaching the repository. |
| Informational | A06 Vulnerable Components | `pnpm audit --prod` (re-run after every dependency added this session, including `@better-auth/passkey`): one moderate finding, `esbuild <=0.24.2` (dev-server request/response exposure), reached only transitively via `better-auth > drizzle-kit > @esbuild-kit/*` and now also via `@better-auth/passkey`'s own dependency on `better-auth` — same advisory, same root cause, still a dev-tooling path, not the production runtime bundle. Pre-existing (not introduced this session). No *new* vulnerabilities from anything added this session. | Not fixed: forcing a version override risks breaking `drizzle-kit`'s dev tooling for a dev-only, non-production-path advisory. Documented rather than silently left; revisit when `better-auth`/`drizzle-kit` ship an updated transitive pin. |
| — (checked, no finding) | Secrets in git history | `gitleaks detect` (full history, 3 commits, `--redact`) found 2 pattern matches, both triaged and confirmed **not real secrets**: `scripts/integration-tests.sh`'s `BETTER_AUTH_SECRET="integration-test-secret-0123456789abcdef"` (an obviously-fake, hardcoded value that only ever spins up an ephemeral local Docker Compose stack for integration tests — same throwaway pattern as its adjacent `hoodmint:hoodmint` Postgres credentials) and `packages/providers/fixtures/opensea/pat-exchange.json`'s `"jwt-eyJ...test.sig"` (a mock JWT test fixture for the OpenSea client's PAT-exchange test, whose own test asserts it starts with the literal string `"jwt-"`). Confirmed by reading both files directly, not just trusting the tool's pattern match. | — |
| — (verified, no finding) | A01 Broken Access Control | Every execution server action (`createRpcEndpointAction`, `setRpcEndpointEnabledAction`, `deleteRpcEndpointAction`, `registerBrowserSignerAction`, `revokeSignerAction`, `createMintPlanAction`, `armMintPlanAction`, `disarmMintPlanAction`, `recordBrowserSignatureAction`) calls `requireApi`/`requireFreshStepUp` server-side before any DB write — confirmed by direct grep of every function, not by inspection sampling. All are admin-only in `packages/auth/src/rbac.ts` (operator/viewer excluded by omission, not a denylist) and covered by `rbac.test.ts`. | — |
| — (verified, no finding) | A03 Injection | The atomic `claimArmedMintPlan`/`claimDueAlerts` queries use drizzle-orm's `sql` tagged template with parameter interpolation — this binds as a parameter, not string concatenation. No raw string building of SQL anywhere in the new code. | — |
| — (verified, no finding) | Custody | Confirmed there is currently **no code path anywhere in the repository that broadcasts a transaction**, for any signer scheme, including `browser_wallet` — the server only ever hands back an unsigned tx; the owner's own browser wallet is what signs and broadcasts. `assertSignable` is the only gate a live-mode request passes through, and it hard-throws for every scheme except `browser_wallet`. `LIVE_EXECUTION_ENABLED` is read in exactly one place and has no other reader that could disagree with it. | — |

## Commands run

```bash
brew install gitleaks
gitleaks detect --no-banner --redact --report-format json --report-path /tmp/gitleaks-report.json
pnpm audit --prod
pnpm --filter @hoodmint/providers run test      # rpc-url.test.ts, 8/8
pnpm -r run typecheck                           # 15/15 workspaces
pnpm -r run test
pnpm run lint && pnpm run format:check
```

## Addendum, same day: semgrep SAST pass + the performance finding fixed

Installed `semgrep` (v1.174.0) and ran `p/owasp-top-ten` + `p/typescript` +
`p/react` + `p/nextjs` + `p/secrets` (149 rules, 274 files). Found and
fixed 4/4:

| Severity | Rule | File | Fix |
|---|---|---|---|
| Error | `gcm-no-tag-length` | `packages/secrets/src/index.ts` | Pinned `authTagLength: 16` explicitly on both `createCipheriv`/`createDecipheriv` instead of relying on Node's implicit default. Verified with a throwaway roundtrip before editing the real module; `packages/secrets` tests 10/10 pass; on-disk sealed-secret format unchanged. |
| Medium | `pnpm-block-exotic-sub-dependencies` | `pnpm-workspace.yaml` | Already pnpm 11's default (`true`) — pinned explicitly as a downgrade guard, not a live gap. |
| Medium | `pnpm-missing-minimum-release-age` | `pnpm-workspace.yaml` | Already defaulted to 1440 min (24h) on pnpm 11 — raised to 10080 (7 days) explicitly. Broke `pnpm install` on 12 lockfile entries (`@peculiar/asn1-*`, `jose` — all transitive `@better-auth/passkey` deps published within the cutoff); added them to `minimumReleaseAgeExclude` by exact version, re-verified `pnpm install` passes clean. |
| Medium | `pnpm-trust-policy` | `pnpm-workspace.yaml` | Genuine gap (real default: `off`). Set `trustPolicy: no-downgrade`. |

Re-ran semgrep after fixes: **0 findings.** Full verification gate
(typecheck, unit tests, live integration tests against a real Postgres,
lint, format) re-run clean after — see `docs/execution-architecture.md`'s
eighth pass for the complete writeup, including the `bestEligibilityByProject`
performance finding from earlier the same day, which this same pass also
fixed (was previously documented-but-not-fixed) and covered with a new
live integration test, plus a related dead-code SQL-injection landmine
(`walletChipsForProjects`'s raw-SQL string interpolation) found and fixed
alongside it.

## Addendum, same day: the mint-execution claim function never actually
## claimed anything (eleventh pass)

Not a vulnerability in the traditional sense — a correctness bug with
security-relevant consequences worth recording here because of what it
affects. `claimArmedMintPlan` (`packages/db/src/repositories/execution.ts`)
— the function that atomically claims one armed, due mint plan so the
execution worker can fire it — silently returned `undefined` on every
call, for the entire session up to this point, because of a driver-shape
mismatch in raw SQL result handling (`result.rows ?? []` against a
`postgres`-npm-package driver result that has no `.rows` property at
all, confirmed with a live repro against real Postgres). Net effect: the
mint-execution pipeline could never fire a mint, no matter how correctly
arm/disarm, step-up auth, signer config, and spend ceilings were set up —
a fail-safe direction for a feature this security-sensitive, but a
correctness bug regardless, and one that would have silently defeated
the entire point of building live execution had it shipped unnoticed.
Found via live UI verification (an admin dashboard tile reading 0 when
it should have read a real number), not by design review — the same
pattern was present in 7 other files across the codebase (worker
aggregate-refresh triggers, alert-channel test/list actions, an admin
overview stat). All fixed and live-verified; see
`docs/execution-architecture.md`'s eleventh pass for the full account.

## Still not done, honestly

`opengrep` (the LGPL semgrep fork) was not separately run — semgrep's
community rule packs used here are free under the Semgrep Rules License,
which is fine for this personal/self-hosted project; opengrep would only
matter if this were commercial/SaaS reuse. No penetration testing in the
literal sense (external attacker probing a live deployment) has been
attempted — arguably not very meaningful for a single-operator,
not-yet-publicly-deployed app, but not yet discussed with the owner either.

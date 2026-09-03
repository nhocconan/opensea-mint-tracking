# Managed minting keys — custody security review (2026-08-28)

> **Update (2026-08-28, second pass — all findings fixed):** the six findings
> from the second review are implemented and tested. Summary of what changed:
>
> 1. **Pre-signed raw tx purged on every terminal transition** (disarm,
>    expiry, executed, failed, cancel-on-delete) — `PURGE_PRESIGNED` in
>    `packages/db/src/repositories/execution.ts`. Previously only revoke/delete
>    purged it.
> 2. **Worker-only decryption (X25519 envelope).** Imported keys are sealed to
>    `WALLET_KEY_PUBLIC_KEY` (`sealToRecipient`: ephemeral X25519 → HKDF-SHA256
>    → AES-256-GCM). Only the worker holds `WALLET_KEY_PRIVATE_KEY`; the web
>    container holds nothing that can decrypt a minting key. Legacy symmetric
>    blobs are re-sealed automatically by the worker (`resealLegacyWalletKeys`,
>    at boot + hourly, compare-and-swap so a concurrent revoke wins). The
>    wallets page shows a "legacy seal" badge until then. `make wallet-keys`.
> 3. **Root secrets off `.env`:** `APP_ENCRYPTION_KEY`, `WALLET_KEY_PRIVATE_KEY`,
>    `WALLET_KEY_PUBLIC_KEY`, `BETTER_AUTH_SECRET` accept `<NAME>_FILE=/path`
>    (Compose `secrets:` / tmpfs / secret-manager sidecar), so they appear in
>    neither `.env` nor `docker inspect`. `compose.prod.yaml.sample` mounts the
>    worker's private half as a Compose secret and blanks it on web.
> 4. **Dead tuples:** `vacuumKeyTables` (plain `VACUUM wallets, mint_plans,
>    audit_logs`) runs after every revoke/delete; the audit row records whether
>    it succeeded.
> 5. **Import field is no longer `type="password"`** — browsers offer to save
>    password fields into the OS / password-manager vault regardless of
>    `autocomplete=off`. It is a text field masked with `text-security`, with
>    1Password/LastPass/Bitwarden ignore attributes, and is reset the instant
>    the form submits.
> 6. **Tests:** `packages/db/tests/integration.test.ts` "managed minting-key
>    hygiene" (6 cases against real Postgres) + `packages/secrets` envelope
>    tests (public half cannot open, tamper, wrong key, dispatch, no blob in
>    error messages) + `packages/config` `_FILE` tests.
> 7. **Process memory (inherent):** JS strings cannot be zeroed. The derived
>    AES key and ECDH shared secret *are* zeroed (`Buffer.fill(0)`) after use;
>    the hex private key itself exists as a V8 string from decrypt until GC.
>    Anyone who can read worker memory already has root on the host.
>
> Stored-blob parsing (`openWalletKey`) also validates shape before crypto so
> a corrupt row raises a fixed message — `JSON.parse`'s own error would have
> quoted the ciphertext into attempt rows/logs.
>
> **Deploy steps (operator):** `make wallet-keys` → put `WALLET_KEY_PUBLIC_KEY`
> in `.env.prod`, the private half in `./secrets/wallet_key_private` (chmod
> 600) referenced by `WALLET_KEY_PRIVATE_KEY_FILE` on the worker service only
> (see `compose.prod.yaml.sample`), restart worker then web. The worker
> re-seals the existing managed key on boot; the badge disappears.

Owner question: *"When I add a private key to the site, is it safe? Encrypted at
rest so a hacker on the server can't steal it? And when I revoke, is it gone
everywhere, no trace?"* This is the honest, code-verified answer.

## What happens to a key, step by step

| Step | Where | What is stored / visible |
|---|---|---|
| Import (Admin → Wallets) | `importWalletKeyAction` | Requires admin RBAC **and** a fresh WebAuthn passkey step-up. Key is validated, its address derived, then **sealed to the worker's X25519 public key** (`sealToRecipient`: ephemeral ECDH → HKDF-SHA256 → AES-256-GCM, random 96-bit nonce, 128-bit tag). The web process cannot decrypt what it just sealed. (Fallback when `WALLET_KEY_PUBLIC_KEY` is unset: symmetric AES-256-GCM under `APP_ENCRYPTION_KEY`, flagged "legacy seal" in the UI and re-sealed by the worker once the keypair exists.) Only the ciphertext + a one-way sha256 fingerprint reach Postgres. |
| Audit log | `audit_logs` | Address only. **No key fingerprint, no key material** (the fingerprint was removed from audit metadata; `scrubKeyTracesForAddress` also strips it from any older rows on revoke/delete). |
| Admin UI / API | `listWallets` | Never selects the ciphertext column; shows only `hasSigningKey` + fingerprint. |
| Pre-sign (T-45s) & fire | `apps/worker/src/workers/execution.ts` (2 call sites) | Ciphertext is fetched, decrypted **in the worker process memory only**, handed straight to the signing chokepoint (`packages/signing`), and the local goes out of scope. It is never written anywhere. |
| Logs | pino | Redaction list covers `privateKey`, `encryptedSigningKey`, `presignedRawTx`, `rawTx`, `sessionKey` (+ nested). No log call in the fire path references key material (grep-verified). Postgres `log_statement = none`. |
| Pre-signed raw tx | `mint_plans.presigned_raw_tx` | A signed tx is spend-capable *for that exact mint only* (fixed to/data/value/nonce). Short TTL; purged on **every** terminal transition (cancelled/expired/executed/failed) and on revoke/delete. Integration-tested. |
| Revoke key | `revokeWalletKeyAction` | Ciphertext + fingerprint + added-at **set to NULL**, every pre-signed blob for the wallet purged, audit metadata scrubbed, key tables vacuumed. |
| Delete wallet | `deleteWalletAction` | Same purge + open plans cancelled (nothing can ever fire), then the row is deleted (ciphertext gone with it), key tables vacuumed. |

## Threat model — what this protects against, and what it does not

**Protected:**
- A leaked **database dump / backup** (`make backup`), a stolen Postgres volume, or a read-only DB compromise: ciphertext only, useless without `APP_ENCRYPTION_KEY`.
- Log scraping, error reporting, the admin UI, the JSON API: no key material anywhere.
- An admin session without a passkey: cannot import or arm (WebAuthn step-up).
- After revoke/delete: no live copy in the DB, no pre-signed tx, no key-derived audit value.

**Also protected (since the second pass):**
- A compromised **web** container (the internet-facing process): it holds only the X25519 public half → cannot decrypt any minting key.

**NOT protected (be clear-eyed):**
1. **Full server compromise while the app runs.** Root on the host can read the worker's environment/secret file and the DB → can decrypt. At-rest encryption cannot defend against root on the box that holds the key. Mitigations, in order of value: keep only **burner** funds on managed wallets; supply `WALLET_KEY_PRIVATE_KEY_FILE` from a tmpfs/secret-manager sidecar so a cold disk copy has no key; host hardening (SSH keys only, fail2ban, minimal open ports).
2. **Postgres internals after revoke.** Plain `VACUUM` now runs right after revoke/delete, so dead tuples are reclaimed promptly; WAL segments may still hold the ciphertext until recycled (`archive_mode=off` in prod, so nothing is retained long-term). This is *ciphertext*, still protected by (1).
3. **Process memory.** JavaScript strings cannot be zeroed; the decrypted key exists in the worker's heap briefly at sign time and until GC. Standard for Node; an attacker who can read worker memory already has root (see 1).
4. **Backups made while the key was present** contain the ciphertext (again: useless without `APP_ENCRYPTION_KEY`). Rotating `APP_ENCRYPTION_KEY` invalidates every old ciphertext everywhere — the nuclear option after an incident.

## Verified in this review
- Two and only two decrypt sites, both in the worker fire/pre-sign path.
- Zero log statements referencing key/raw-tx variables; redaction paths present.
- Audit metadata on import: `{ address }` only.
- Revoke/delete paths purge pre-signed blobs and scrub audit rows.
- `.env` is `600 root`; Postgres statement logging is off; no backup dumps present on disk.

## Recommended next hardening (not yet done)
1. Supply `WALLET_KEY_PRIVATE_KEY_FILE` / `APP_ENCRYPTION_KEY_FILE` from a secret manager or tmpfs at container start, so a cold copy of the disk holds no decryption key (the `_FILE` plumbing exists; the sidecar/source is an ops choice).
2. Alert on any `wallet.key_import` / `wallet.key_revoke` audit event to Telegram (Admin → Alerts).

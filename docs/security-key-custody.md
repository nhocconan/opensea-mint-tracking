# Managed minting keys — custody security review (2026-08-28)

Owner question: *"When I add a private key to the site, is it safe? Encrypted at
rest so a hacker on the server can't steal it? And when I revoke, is it gone
everywhere, no trace?"* This is the honest, code-verified answer.

## What happens to a key, step by step

| Step | Where | What is stored / visible |
|---|---|---|
| Import (Admin → Wallets) | `importWalletKeyAction` | Requires admin RBAC **and** a fresh WebAuthn passkey step-up. Key is validated, its address derived, then **sealed with AES-256-GCM** (`packages/secrets` `sealSecret`, random 96-bit nonce, 128-bit auth tag, key = `APP_ENCRYPTION_KEY`). Only the ciphertext + a one-way sha256 fingerprint reach Postgres (`wallets.encrypted_signing_key`, `signing_key_fingerprint`). |
| Audit log | `audit_logs` | Address only. **No key fingerprint, no key material** (the fingerprint was removed from audit metadata; `scrubKeyTracesForAddress` also strips it from any older rows on revoke/delete). |
| Admin UI / API | `listWallets` | Never selects the ciphertext column; shows only `hasSigningKey` + fingerprint. |
| Pre-sign (T-45s) & fire | `apps/worker/src/workers/execution.ts` (2 call sites) | Ciphertext is fetched, decrypted **in the worker process memory only**, handed straight to the signing chokepoint (`packages/signing`), and the local goes out of scope. It is never written anywhere. |
| Logs | pino | Redaction list covers `privateKey`, `encryptedSigningKey`, `presignedRawTx`, `rawTx`, `sessionKey` (+ nested). No log call in the fire path references key material (grep-verified). Postgres `log_statement = none`. |
| Pre-signed raw tx | `mint_plans.presigned_raw_tx` | A signed tx is spend-capable *for that exact mint only* (fixed to/data/value/nonce). Short TTL; purged on revoke/delete/terminal state. |
| Revoke key | `revokeWalletKeyAction` | Ciphertext + fingerprint + added-at **set to NULL**, every pre-signed blob for the wallet purged, audit metadata scrubbed. |
| Delete wallet | `deleteWalletAction` | Same purge + open plans cancelled (nothing can ever fire), then the row is deleted (ciphertext gone with it). |

## Threat model — what this protects against, and what it does not

**Protected:**
- A leaked **database dump / backup** (`make backup`), a stolen Postgres volume, or a read-only DB compromise: ciphertext only, useless without `APP_ENCRYPTION_KEY`.
- Log scraping, error reporting, the admin UI, the JSON API: no key material anywhere.
- An admin session without a passkey: cannot import or arm (WebAuthn step-up).
- After revoke/delete: no live copy in the DB, no pre-signed tx, no key-derived audit value.

**NOT protected (be clear-eyed):**
1. **Full server compromise while the app runs.** `APP_ENCRYPTION_KEY` lives in `.env` (mode 600, root) on the same host as the DB. An attacker with root on this box has both the ciphertext and the key → can decrypt. At-rest encryption cannot defend against root on the box that holds the key. Mitigations, in order of value: keep only **burner** funds on managed wallets (you already plan this); move `APP_ENCRYPTION_KEY` off disk (inject at boot from a secret manager / an operator prompt, so a cold copy of the disk has no key); host hardening (SSH keys only, fail2ban, minimal open ports).
2. **Postgres internals after revoke.** Setting the column to NULL leaves the old row version as a dead tuple until `VACUUM` runs, and WAL segments may hold the ciphertext for a while. This is *ciphertext*, still protected by (1). If you want belt-and-braces: `VACUUM FULL wallets;` after a revoke, and don't keep WAL archives.
3. **Process memory.** JavaScript strings cannot be zeroed; the decrypted key exists in the worker's heap briefly at sign time and until GC. Standard for Node; an attacker who can read worker memory already has root (see 1).
4. **Backups made while the key was present** contain the ciphertext (again: useless without `APP_ENCRYPTION_KEY`). Rotating `APP_ENCRYPTION_KEY` invalidates every old ciphertext everywhere — the nuclear option after an incident.

## Verified in this review
- Two and only two decrypt sites, both in the worker fire/pre-sign path.
- Zero log statements referencing key/raw-tx variables; redaction paths present.
- Audit metadata on import: `{ address }` only.
- Revoke/delete paths purge pre-signed blobs and scrub audit rows.
- `.env` is `600 root`; Postgres statement logging is off; no backup dumps present on disk.

## Recommended next hardening (not yet done)
1. `APP_ENCRYPTION_KEY` out of `.env`: read from a secret manager or an operator prompt at container start.
2. Post-revoke `VACUUM` job (or run it in the revoke action) to drop dead tuples promptly.
3. Alert on any `wallet.key_import` / `wallet.key_revoke` audit event to Telegram (Admin → Alerts).

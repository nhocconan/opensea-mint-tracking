# HoodMint Radar — Admin operator guide

Everything you do day-to-day lives under **`/admin`** (the Admin CP). This is
the runbook for first login, configuration, tracking, and minting.

Live site: `https://osmint.dic.app` · Admin CP: `https://osmint.dic.app/admin`

---

## 1. First login — there is no default password (by design)

HoodMint ships with **no seeded admin account and no default credentials** —
that would be the first thing an attacker tries. You create the first admin
once, with a one-time bootstrap token:

1. Generate a token on the server (valid 30 min, single use):
   ```
   make token-prod     # Dockerized prod stack (this deployment)
   ```
   Use `make token-prod` for the containerized production stack — it mints the
   token straight into Postgres via the running `postgres` container. (Plain
   `make token` is LOCAL-DEV only: it runs on the host and needs
   APP_ENCRYPTION_KEY / DATABASE_URL / VALKEY_URL in the shell plus a reachable
   DB, which the prod-behind-Traefik topology deliberately does not expose — it
   will fail with "Invalid environment configuration" there.)
2. Open **`/setup`**, paste the token, and create your admin email + password
   (min 12 chars). `/setup` closes itself once an admin exists; public signup
   stays disabled.
3. From then on you sign in at **`/login`** and manage everything at **`/admin`**.

**Harden your login (recommended):** after first sign-in, register a **passkey**
and enable **2FA (TOTP)**. The login page supports **passkey sign-in** and a
**remember-me** option; repeated failed sign-ins are rate-limited and lock out
with escalating backoff. Arming a mint additionally requires a fresh passkey
step-up — a password alone can never arm or import a spend key.

---

## 2. OpenSea API key

Preferred path is encrypted-at-rest in the app, not an env file:

- **Admin → OpenSea → paste your key → Save.** Stored AES-256-GCM encrypted,
  shown only as a fingerprint, picked up by the worker within a cycle.
- Get a key from the OpenSea Developer Platform. If you skip it, the app
  auto-creates and rotates a free 7-day instant key.

---

## 3. Wallets — tracking vs. managed (minting)

**Admin → Wallets.**

- **Tracking wallet** (address only): add via *Add wallet* or paste many in
  *Bulk add*. Used for allowlist-eligibility checks. Your default tracking
  wallet is prefilled from config.
- **Managed wallet** (can mint autonomously): *Import minting key* — paste a
  **burner** wallet's private key. It is **AES-256-GCM encrypted on save**,
  shown only as a fingerprint, and decrypted **only in the worker at the mint
  instant** — never logged. Importing requires a passkey step-up. The wallet
  then shows a **managed** badge; *Remove key* revokes it.

> **Burner wallets only.** A managed wallet should hold just your mint budget +
> gas. Minted NFTs land in the wallet that mints (or a pinned recipient), never
> exposing your main funds.

You can create one mint plan across **many** managed wallets at once (see §6).

---

## 4. Finding mints you can enter

All multi-mint feeds and the Calendar keep their filters in the URL, so a filtered view survives
refresh and can be bookmarked.

- **WL → WL hit:** shows phases where at least one enabled tracked wallet has a confirmed
  restricted-stage hit for that exact phase.
- **WL → No WL hit:** shows phases without a confirmed hit. Check the visible wallet chips before
  deciding: `UNKNOWN` and `AUTH NEEDED` are unresolved, not confirmed rejections.
- **Links:** require X, a website, either one, or both. Missing links are excluded server-side.
- **Clear filters:** removes search, price, WL, and link filters while preserving the selected sort.

Public-only phases never count as WL.

---

## 5. X / Grok hype & risk signals

**Admin → Signals.** Uses your **X Premium+ / SuperGrok** subscription via xAI
Grok OAuth — no separate X API billing.

1. Set `X_SIGNALS_ENABLED=true` in the deployment env and restart.
2. Click **Connect X (Grok) account**, open the shown `x.ai` link, approve the
   code. Tokens are stored encrypted and auto-refresh.
3. Grok's live X search then scores hype and phishing-risk for near-mint
   projects. (Alternatively paste a `console.x.ai` API key.)

---

## 6. Minting — plans, arming, and going live

**Admin → Execution.**

1. **Create a mint plan:** pick a project, select one or more **wallets**
   (multi-select), optionally a **stage** (enables the 200 ms precision fire)
   and a **signer**, set quantity + per-plan ceiling. One plan is created per
   wallet.
2. **Arm** each plan — this requires a **fresh passkey step-up**, not just a
   session. Arming has a capped window.
3. **Shadow vs. live:** with `LIVE_EXECUTION_ENABLED=false` (the hard default)
   the worker only *simulates* ("would have fired") — nothing is signed or
   broadcast. Flip it to `true` **only** once you have funded burners, imported
   keys, and accepted the risk. Then armed managed-key plans fire and broadcast
   autonomously at the stage-open instant; multiple wallets fire in parallel.

**Signer schemes:** `browser_wallet` (you sign each in your own wallet),
`managed_wallet_key` (worker signs with your imported burner key — autonomous),
and the delegated `custom_executor` contract path.

---

## 7. Alerts, audit, system

- **Admin → Alerts:** Telegram / webhook / Discord / Web Push, with a test
  button. `stage_starting` alerts fire at configurable lead windows.
- **Admin → Audit log:** every credential, wallet-key, arm, and execution
  action is recorded (never with secret material).
- **Admin → System:** retention, demo-data toggle, provider health.

---

## Security model at a glance

- All credentials + signing keys: AES-256-GCM at rest, fingerprint-only display,
  redacted from logs/errors/exports.
- Spend-capable actions (import key, arm) require a WebAuthn passkey step-up.
- Autonomous broadcast is gated by `LIVE_EXECUTION_ENABLED` (default off).
- The app never asks for seed phrases; import only burner private keys.

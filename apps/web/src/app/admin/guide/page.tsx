import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Guide" };
export const dynamic = "force-dynamic";

const FULL_DOC = "https://github.com/nhocconan/opensea-mint-tracking/blob/main/docs/admin-guide.md";

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        {n}. {title}
      </h2>
      <div className="mt-2 space-y-2 text-sm text-ink-muted">{children}</div>
    </section>
  );
}

/** Admin → Guide: in-app operator runbook (mirror of docs/admin-guide.md). */
export default function AdminGuidePage() {
  return (
    <div className="space-y-3">
      <section className="rounded-md border border-acid/30 bg-base-raised p-4">
        <h1 className="font-display text-lg font-semibold tracking-tight">Operator guide</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Everything day-to-day lives under <code className="text-acid">/admin</code>. Full
          reference:{" "}
          <a
            href={FULL_DOC}
            target="_blank"
            rel="noopener noreferrer"
            className="text-acid underline"
          >
            docs/admin-guide.md
          </a>
          .
        </p>
      </section>

      <Step n={1} title="First login — no default password">
        <p>
          There is <strong>no seeded admin</strong> by design. Create the first admin once with a
          one-time bootstrap token: run <code className="text-acid">make token</code> on the server,
          open{" "}
          <Link href="/setup" className="text-acid underline">
            /setup
          </Link>
          , paste it, and set your email + password (min 12 chars). Afterwards sign in at{" "}
          <Link href="/login" className="text-acid underline">
            /login
          </Link>
          .
        </p>
        <p>
          Then harden it: register a <strong>passkey</strong> and enable <strong>2FA</strong>. Login
          supports passkey sign-in, remember-me, and brute-force lockout; arming a mint always needs
          a fresh passkey step-up.
        </p>
      </Step>

      <Step n={2} title="OpenSea API key">
        <p>
          <Link href="/admin/opensea" className="text-acid underline">
            Admin → OpenSea
          </Link>{" "}
          → paste your key (encrypted at rest). Optional — the app auto-creates a free instant key
          if absent.
        </p>
      </Step>

      <Step n={3} title="Wallets — tracking vs. managed">
        <p>
          <Link href="/admin/wallets" className="text-acid underline">
            Admin → Wallets
          </Link>
          : add tracking addresses (single or bulk) for eligibility. To mint, use{" "}
          <strong>Import minting key</strong> — paste a <strong>burner</strong> private key; it is
          AES-256-GCM encrypted on save, decrypted only at the mint instant, never logged, and needs
          a passkey step-up. Burner wallets only — hold just mint budget + gas.
        </p>
      </Step>

      <Step n={4} title="X / Grok signals">
        <p>
          <Link href="/admin/signals" className="text-acid underline">
            Admin → Signals
          </Link>{" "}
          → Connect X (Grok) account with your X Premium+/SuperGrok subscription (no separate X API
          billing). Grok's live X search scores hype and phishing-risk for near-mint projects.
        </p>
      </Step>

      <Step n={5} title="Minting — plans, arm, go live">
        <p>
          <Link href="/admin/execution" className="text-acid underline">
            Admin → Execution
          </Link>
          : create a plan across one or many managed wallets (optionally pick a stage for 200 ms
          precision fire), then <strong>arm</strong> it (passkey step-up).
        </p>
        <p>
          With <code className="text-acid">LIVE_EXECUTION_ENABLED=false</code> (default) the worker
          only simulates. Set it <code className="text-acid">true</code> once burners are funded and
          keys imported — then armed managed-key plans fire and broadcast autonomously, multiple
          wallets in parallel, at the stage-open instant.
        </p>
      </Step>

      <Step n={6} title="Alerts, audit, system">
        <p>
          <Link href="/admin/alerts" className="text-acid underline">
            Alerts
          </Link>{" "}
          (Telegram / webhook / Discord / Web Push, with stage-starting lead windows),{" "}
          <Link href="/admin/audit" className="text-acid underline">
            Audit log
          </Link>{" "}
          (every sensitive action, no secrets), and{" "}
          <Link href="/admin/system" className="text-acid underline">
            System
          </Link>{" "}
          (retention, demo data, provider health).
        </p>
      </Step>
    </div>
  );
}

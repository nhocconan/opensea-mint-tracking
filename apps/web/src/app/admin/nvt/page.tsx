import { listCredentials } from "@hoodmint/db";
import Link from "next/link";
import { getNvtDiscordAdminDataAction } from "@/app/actions.ts";
import { container } from "@/lib/container.ts";
import { formatDateTime } from "@/lib/format.ts";
import {
  NvtApiKeyForm,
  NvtDiscordSettingsForm,
  NvtTestButton,
  RevokeNvtCredentialButton,
} from "./nvt-forms.tsx";

export const dynamic = "force-dynamic";

function metaString(metadata: Record<string, unknown> | null, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function metaNumber(metadata: Record<string, unknown> | null, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Admin → NeverFuckingTrade: configure API key for NeverFuckingTrade (NFT Trencher)
 * service. Credentials are encrypted at rest with AES-256-GCM and write-only
 * after save (PRD §11).
 */
export default async function AdminNvtPage() {
  const { db, config } = container();
  const allCredentials = await listCredentials(db).catch(() => []);
  const nvtCredentials = allCredentials.filter(
    (c) => c.type === "nvt_api_key" || c.type === "nvt_discord_webhook",
  );
  const primaryCredential = nvtCredentials.find((c) => c.type === "nvt_api_key");
  const discordData = await getNvtDiscordAdminDataAction();

  const hasEnvKey = Boolean(config.NVT_API_KEY);
  const isConfigured = primaryCredential !== undefined || hasEnvKey;
  const health = primaryCredential ? metaString(primaryCredential.metadata, "health") : undefined;
  const lastError = primaryCredential
    ? metaString(primaryCredential.metadata, "lastErrorCode")
    : undefined;
  const lastTestedAt = primaryCredential
    ? metaString(primaryCredential.metadata, "lastTestedAt")
    : undefined;
  const tier = primaryCredential ? metaString(primaryCredential.metadata, "tier") : undefined;
  const usage = primaryCredential ? metaNumber(primaryCredential.metadata, "usage") : undefined;
  const limit = primaryCredential ? metaNumber(primaryCredential.metadata, "limit") : 120;
  const profileAddress = primaryCredential
    ? metaString(primaryCredential.metadata, "address")
    : undefined;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {/* Overview Card */}
      <section className="rounded-md border border-line bg-base-raised p-4 md:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
            NeverFuckingTrade (NFT Trencher) Live Radar &amp; Whitelist Service
          </h2>
          <Link
            href="/my-mints-nvt"
            className="inline-flex items-center gap-1 rounded-sm border border-acid/40 bg-acid/10 px-2.5 py-1 font-mono text-xs text-acid hover:bg-acid/20"
          >
            Open My Mints - NVT &rarr;
          </Link>
        </div>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-4 font-mono">
          <div>
            <dt className="text-ink-faint">Status</dt>
            <dd className="font-semibold">
              {isConfigured ? (
                health === "healthy" ? (
                  <span className="text-acid">Configured &amp; Healthy</span>
                ) : health === "unhealthy" ? (
                  <span className="text-magenta">Degraded ({lastError ?? "error"})</span>
                ) : (
                  <span className="text-cyan">Configured (Saved)</span>
                )
              ) : (
                <span className="text-amber">Key not configured</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-ink-faint">Active credential source</dt>
            <dd className="text-ink-muted">
              {primaryCredential !== undefined
                ? `Stored encrypted key (••••${primaryCredential.fingerprint.slice(-4)})`
                : hasEnvKey
                  ? "NVT_API_KEY from environment"
                  : "None"}
            </dd>
          </div>
          <div>
            <dt className="text-ink-faint">Base API URL</dt>
            <dd className="truncate text-ink-muted">{config.NVT_BASE_URL}</dd>
          </div>
          <div>
            <dt className="text-ink-faint">Quota &amp; Rate Limit</dt>
            <dd className="text-ink-muted">
              {usage !== undefined ? `${usage} / ${limit}` : `${limit}`} req/min
              {tier ? ` · ${tier.toUpperCase()}` : ""}
            </dd>
          </div>
          {profileAddress ? (
            <div className="sm:col-span-2">
              <dt className="text-ink-faint">Account address</dt>
              <dd className="text-cyan truncate">{profileAddress}</dd>
            </div>
          ) : null}
          {lastTestedAt ? (
            <div className="sm:col-span-2">
              <dt className="text-ink-faint">Last verified</dt>
              <dd className="text-ink-faint">{formatDateTime(new Date(lastTestedAt))}</dd>
            </div>
          ) : null}
        </dl>
        <p className="mt-3 text-[11px] text-ink-faint">
          NeverFuckingTrade powers real-time mint discovery, whitelist stage validation (GTD / FCFS
          / Allowlist), and cross-chain tracking across Robinhood Chain, Ethereum, Ink, and
          HyperEVM.
        </p>
      </section>

      {/* Add / Update Key Form */}
      <NvtApiKeyForm />

      {/* Test & Verification Section */}
      <section className="rounded-md border border-line bg-base-raised p-4">
        <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Verify &amp; Connection Status
        </h2>
        <p className="mt-1 text-[11px] text-ink-muted">
          Test the currently active API key by querying NeverFuckingTrade&apos;s{" "}
          <span className="font-mono">/api/v1/me</span> endpoint. This validates authorization,
          refreshes rate quota limits, and discovers profile accounts.
        </p>
        <NvtTestButton />
        <div className="mt-4 border-t border-line/60 pt-3 text-[11px] text-ink-faint space-y-1">
          <p>
            Documentation:{" "}
            <a
              href="https://cdn.neverfuckingtrade.com/api/"
              target="_blank"
              rel="noreferrer noopener"
              className="text-cyan hover:underline"
            >
              https://cdn.neverfuckingtrade.com/api/
            </a>
          </p>
          <p>
            Community &amp; support:{" "}
            <a
              href="https://t.me/neverfuckingtrade"
              target="_blank"
              rel="noreferrer noopener"
              className="text-cyan hover:underline"
            >
              Telegram
            </a>{" "}
            ·{" "}
            <a
              href="https://x.com/neverfkngtrade"
              target="_blank"
              rel="noreferrer noopener"
              className="text-cyan hover:underline"
            >
              @neverfkngtrade on X
            </a>
          </p>
        </div>
      </section>

      {/* Automated Discord Alerts & Scan Schedule */}
      <div className="md:col-span-2">
        <NvtDiscordSettingsForm data={discordData} />
      </div>

      {/* Stored Credentials Table */}
      <section className="rounded-md border border-line bg-base-raised p-4 md:col-span-2">
        <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Stored NeverFuckingTrade credentials (masked)
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">
              NeverFuckingTrade credentials stored encrypted at rest
            </caption>
            <thead>
              <tr className="text-[10px] text-ink-faint uppercase">
                <th scope="col" className="py-1 font-normal">
                  Type
                </th>
                <th scope="col" className="py-1 font-normal">
                  Name
                </th>
                <th scope="col" className="py-1 font-normal">
                  Fingerprint
                </th>
                <th scope="col" className="py-1 font-normal">
                  Health
                </th>
                <th scope="col" className="py-1 font-normal">
                  Last error
                </th>
                <th scope="col" className="py-1 font-normal">
                  Created
                </th>
                <th scope="col" className="py-1 font-normal">
                  Revoke
                </th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {nvtCredentials.map((c) => (
                <tr key={c.id}>
                  <td className="py-1">{c.type}</td>
                  <td className="py-1">{c.name}</td>
                  <td className="py-1 text-ink-muted">••••{c.fingerprint.slice(-4)}</td>
                  <td
                    className={`py-1 ${
                      metaString(c.metadata, "health") === "healthy"
                        ? "text-acid"
                        : metaString(c.metadata, "health") === "unhealthy"
                          ? "text-magenta"
                          : "text-ink-faint"
                    }`}
                  >
                    {metaString(c.metadata, "health") ?? "untested"}
                  </td>
                  <td className="py-1 text-magenta/80">
                    {metaString(c.metadata, "lastErrorCode") ?? "—"}
                  </td>
                  <td className="py-1 text-ink-faint">{formatDateTime(c.createdAt)}</td>
                  <td className="py-1">
                    <RevokeNvtCredentialButton id={c.id} />
                  </td>
                </tr>
              ))}
              {nvtCredentials.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-2 text-ink-faint">
                    {hasEnvKey
                      ? "Using NVT_API_KEY from environment. You can save an encrypted key above to override."
                      : "No NeverFuckingTrade credentials stored yet. Enter your API key above."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-ink-faint">
          Secrets are AES-256-GCM encrypted at rest and write-only after save. The UI shows a
          one-way fingerprint only.
        </p>
      </section>
    </div>
  );
}

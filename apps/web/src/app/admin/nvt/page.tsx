import { listCredentials } from "@hoodmint/db";
import Link from "next/link";
import { getNvtDiscordAdminDataAction } from "@/app/actions.ts";
import { container } from "@/lib/container.ts";
import { formatDateTime } from "@/lib/format.ts";
import {
  NvtApiKeyForm,
  NvtDiscordSettingsForm,
  NvtOpenSeaPassForm,
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
    (c) =>
      c.type === "nvt_api_key" || c.type === "nvt_discord_webhook" || c.type === "nvt_opensea_pass",
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
    <div className="grid gap-4 md:grid-cols-2">
      {/* Overview Card */}
      <section className="rounded-lg border border-line bg-base-raised p-5 shadow-xs md:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-2 rounded-full bg-acid animate-pulse" aria-hidden />
            <h2 className="font-display text-base font-semibold text-ink">
              NeverFuckingTrade (NFT Trencher) Live Radar &amp; Whitelist Engine
            </h2>
          </div>
          <Link
            href="/my-mints-nvt"
            className="inline-flex items-center gap-1.5 rounded-md border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs font-medium text-acid hover:bg-acid/25 transition-colors"
          >
            <span>Open My Mints - NVT</span>
            <span aria-hidden>&rarr;</span>
          </Link>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 font-mono text-xs">
          <div className="rounded-md border border-line/60 bg-base/50 p-3">
            <div className="text-[11px] text-ink-faint">Service Health</div>
            <div className="mt-1 flex items-center gap-2">
              <span
                className={`size-2 rounded-full ${
                  isConfigured && health === "healthy"
                    ? "bg-acid"
                    : isConfigured && health === "unhealthy"
                      ? "bg-magenta"
                      : isConfigured
                        ? "bg-cyan"
                        : "bg-amber"
                }`}
              />
              <span className="font-semibold text-sm">
                {isConfigured ? (
                  health === "healthy" ? (
                    <span className="text-acid">Healthy &amp; Active</span>
                  ) : health === "unhealthy" ? (
                    <span className="text-magenta">Degraded ({lastError ?? "error"})</span>
                  ) : (
                    <span className="text-cyan">Configured</span>
                  )
                ) : (
                  <span className="text-amber">Key Required</span>
                )}
              </span>
            </div>
          </div>

          <div className="rounded-md border border-line/60 bg-base/50 p-3">
            <div className="text-[11px] text-ink-faint">Active Credential</div>
            <div className="mt-1 truncate font-medium text-ink">
              {primaryCredential !== undefined
                ? `Stored key (••••${primaryCredential.fingerprint.slice(-4)})`
                : hasEnvKey
                  ? "NVT_API_KEY from env"
                  : "Not configured"}
            </div>
          </div>

          <div className="rounded-md border border-line/60 bg-base/50 p-3">
            <div className="text-[11px] text-ink-faint">Quota &amp; Rate Limit</div>
            <div className="mt-1 font-medium text-ink">
              {usage !== undefined ? `${usage} / ${limit}` : `${limit}`} req/min
              {tier ? (
                <span className="text-acid ml-1 font-mono text-[11px]">[{tier.toUpperCase()}]</span>
              ) : (
                ""
              )}
            </div>
          </div>

          <div className="rounded-md border border-line/60 bg-base/50 p-3">
            <div className="text-[11px] text-ink-faint">API Endpoint</div>
            <div className="mt-1 truncate font-medium text-ink-muted">{config.NVT_BASE_URL}</div>
          </div>

          {profileAddress ? (
            <div className="rounded-md border border-line/60 bg-base/50 p-3 sm:col-span-2">
              <div className="text-[11px] text-ink-faint">Associated Profile Account</div>
              <div className="mt-1 truncate font-medium text-cyan">{profileAddress}</div>
            </div>
          ) : null}

          {lastTestedAt ? (
            <div className="rounded-md border border-line/60 bg-base/50 p-3 sm:col-span-2">
              <div className="text-[11px] text-ink-faint">Last Health Check (GMT+7)</div>
              <div className="mt-1 font-medium text-ink-muted">
                {formatDateTime(new Date(lastTestedAt))}
              </div>
            </div>
          ) : null}
        </div>

        <p className="mt-4 text-xs text-ink-faint border-t border-line/50 pt-3">
          NeverFuckingTrade powers real-time drop discovery, SIWE OpenSea allowlist validation (GTD
          / FCFS / WL), and cross-chain tracking across Robinhood Chain, Ethereum, Ink, and
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

      {/* OpenSea SIWE Pass for Whitelist Scanning */}
      <div className="md:col-span-2">
        <NvtOpenSeaPassForm passes={discordData.openSeaPasses} />
      </div>

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

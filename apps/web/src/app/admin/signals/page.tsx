import { listCredentials, recentScanRuns } from "@hoodmint/db";
import { XAI_SCOPE } from "@hoodmint/providers";
import { RevokeButton } from "@/app/admin/opensea/credential-forms.tsx";
import { container } from "@/lib/container.ts";
import { formatDateTimeUtc } from "@/lib/format.ts";
import { ConnectXaiButton, XaiApiKeyForm, XaiClientOverrideForm } from "./xai-forms.tsx";

export const dynamic = "force-dynamic";

/** Pending device grants are internal plumbing, not something to manage. */
const VISIBLE_TYPES = ["xai_user_token", "xai_api_key", "xai_oauth_client"] as const;
const ALL_XAI_TYPES = [...VISIBLE_TYPES, "xai_device_pending"] as const;

function metaString(metadata: Record<string, unknown> | null, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Admin → Signals (PRD §7.5, ADR 0007): configure the X hype/risk pipeline,
 * which reads X through xAI's Grok. Everything secret is write-only after
 * save — only fingerprints, scopes, health and expiry are shown, never a
 * token value (PRD §11).
 */
export default async function AdminSignalsPage() {
  const { db, config } = container();
  const [all, scans] = await Promise.all([
    listCredentials(db).catch(() => []),
    recentScanRuns(db, 20).catch(() => []),
  ]);

  const xai = all.filter((c) => (ALL_XAI_TYPES as readonly string[]).includes(c.type));
  const visible = xai.filter((c) => (VISIBLE_TYPES as readonly string[]).includes(c.type));
  const userToken = xai.find((c) => c.type === "xai_user_token");
  const apiKey = xai.find((c) => c.type === "xai_api_key");
  const override = xai.find((c) => c.type === "xai_oauth_client");
  const connected =
    userToken !== undefined && metaString(userToken.metadata, "health") !== "unhealthy";
  const lastScan = scans.find((s) => s.kind === "sentiment");

  const activeSource = connected
    ? "Your X subscription (Grok OAuth)"
    : apiKey !== undefined
      ? "Stored xAI API key"
      : config.XAI_API_KEY !== undefined
        ? "XAI_API_KEY from environment"
        : "None — the scan is a no-op";

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <section className="rounded-md border border-line bg-base-raised p-4 md:col-span-2">
        <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          X hype signals via Grok
        </h2>
        <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-ink-faint">Loop enabled (X_SIGNALS_ENABLED)</dt>
            <dd className={`font-mono ${config.X_SIGNALS_ENABLED ? "text-acid" : "text-amber"}`}>
              {config.X_SIGNALS_ENABLED ? "true" : "false — scan is off"}
            </dd>
          </div>
          <div>
            <dt className="text-ink-faint">Credential in use</dt>
            <dd className="font-mono text-ink-muted">{activeSource}</dd>
          </div>
          <div>
            <dt className="text-ink-faint">Model</dt>
            <dd className="font-mono text-ink-muted">{config.XAI_MODEL}</dd>
          </div>
          <div>
            <dt className="text-ink-faint">Last sentiment scan</dt>
            <dd className="font-mono text-ink-muted">
              {lastScan === undefined ? (
                "never"
              ) : (
                <>
                  {formatDateTimeUtc(lastScan.startedAt)}{" "}
                  <span className={lastScan.status === "success" ? "text-acid" : "text-amber"}>
                    ({lastScan.status})
                  </span>
                </>
              )}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-[11px] text-ink-faint">
          Uses your X Premium+/SuperGrok subscription via xAI Grok OAuth — no separate X API
          billing. Approve at x.ai. Signals are advisory only: they never change a project&apos;s
          confidence, lifecycle, or eligibility.
        </p>
      </section>

      <section className="rounded-md border border-line bg-base-raised p-4">
        <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Connected X (Grok) account
        </h2>
        <p className="mt-1 text-[11px] text-ink-muted">
          Device-code authorization: click Connect, then approve the shown code at x.ai. The access
          token is refreshed automatically an hour before it expires; xAI rotates the refresh token
          every time and the new one is re-encrypted in place.
        </p>
        <ConnectXaiButton />
        <dl className="mt-3 space-y-1 text-[11px]">
          <div className="flex justify-between gap-3">
            <dt className="text-ink-faint">Status</dt>
            <dd className="font-mono">
              {userToken === undefined ? (
                <span className="text-ink-muted">not connected</span>
              ) : connected ? (
                <span className="text-acid">connected</span>
              ) : (
                <span className="text-magenta">
                  unhealthy ({metaString(userToken.metadata, "lastErrorCode") ?? "unknown"})
                </span>
              )}
            </dd>
          </div>
          {userToken !== undefined ? (
            <>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-faint">Access token expires</dt>
                <dd className="font-mono text-ink-muted">
                  {formatDateTimeUtc(userToken.expiresAt)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-faint">Scopes</dt>
                <dd className="font-mono text-ink-muted">
                  {Array.isArray(userToken.metadata?.scopes) && userToken.metadata.scopes.length > 0
                    ? userToken.metadata.scopes.join(" ")
                    : "—"}
                </dd>
              </div>
            </>
          ) : (
            <div className="flex justify-between gap-3">
              <dt className="text-ink-faint">Scopes requested</dt>
              <dd className="font-mono text-ink-muted">{XAI_SCOPE}</dd>
            </div>
          )}
        </dl>
        <XaiClientOverrideForm />
        {override !== undefined ? (
          <p className="mt-2 font-mono text-[11px] text-ink-faint">
            Override active: client {metaString(override.metadata, "clientId") ?? "—"}
          </p>
        ) : null}
      </section>

      <section className="rounded-md border border-line bg-base-raised p-4">
        <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          xAI API key (alternative)
        </h2>
        <p className="mt-1 text-[11px] text-ink-muted">
          A key from console.x.ai, billed separately from your subscription. Used only when no
          healthy connected account exists; takes priority over the
          <span className="font-mono"> XAI_API_KEY</span> environment variable.
        </p>
        <XaiApiKeyForm />
      </section>

      <section className="rounded-md border border-line bg-base-raised p-4 md:col-span-2">
        <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Stored xAI credentials (masked)
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">xAI credentials stored encrypted at rest</caption>
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
                  Expires
                </th>
                <th scope="col" className="py-1 font-normal">
                  Revoke
                </th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {visible.map((c) => (
                <tr key={c.id}>
                  <td className="py-1">{c.type}</td>
                  <td className="py-1">{c.name}</td>
                  <td className="py-1 text-ink-muted">••••{c.fingerprint.slice(-4)}</td>
                  <td
                    className={`py-1 ${
                      metaString(c.metadata, "health") === "unhealthy"
                        ? "text-magenta"
                        : "text-ink-faint"
                    }`}
                  >
                    {metaString(c.metadata, "health") ?? "—"}
                  </td>
                  <td className="py-1 text-magenta/80">
                    {metaString(c.metadata, "lastErrorCode") ?? "—"}
                  </td>
                  <td className="py-1 text-ink-faint">{formatDateTimeUtc(c.expiresAt)}</td>
                  <td className="py-1">
                    <RevokeButton id={c.id} />
                  </td>
                </tr>
              ))}
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-2 text-ink-faint">
                    No xAI credentials stored yet.
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

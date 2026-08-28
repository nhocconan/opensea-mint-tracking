import { listCredentials } from "@hoodmint/db";
import { container } from "@/lib/container.ts";
import { formatDateTimeUtc } from "@/lib/format.ts";
import { CredentialForm, RevokeButton } from "./credential-forms.tsx";
import { RecheckEligibilityButton } from "./recheck-eligibility-button.tsx";

export const dynamic = "force-dynamic";

/**
 * Admin → OpenSea (PRD §7.5): credentials are write-only after save — only
 * fingerprints and expiry are displayed, never values (PRD §11).
 */
export default async function AdminOpenseaPage() {
  const { db } = container();
  const credentials = await listCredentials(db).catch(() => []);

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <CredentialForm
        type="opensea_api_key"
        title="API key"
        hint="Developer Portal key preferred; instant keys rotate automatically when omitted."
      />
      <div>
        <CredentialForm
          type="opensea_pat"
          title="Wallet PAT"
          hint="Must be scoped to read:eligibility only. Exchanged server-side for a ~12h wallet JWT."
        />
        <RecheckEligibilityButton />
      </div>

      <section className="rounded-md border border-line bg-base-raised p-4 md:col-span-2">
        <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Stored credentials (masked)
        </h2>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[10px] text-ink-faint uppercase">
              <th className="py-1 font-normal">Type</th>
              <th className="py-1 font-normal">Name</th>
              <th className="py-1 font-normal">Fingerprint</th>
              <th className="py-1 font-normal">Expires</th>
              <th className="py-1 font-normal">Created</th>
              <th className="py-1 font-normal">Revoke</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {credentials.map((c) => (
              <tr key={c.id}>
                <td className="py-1">{c.type}</td>
                <td className="py-1">{c.name}</td>
                <td className="py-1 text-ink-muted">••••{c.fingerprint.slice(-4)}</td>
                <td className="py-1 text-ink-faint">{formatDateTimeUtc(c.expiresAt)}</td>
                <td className="py-1 text-ink-faint">{formatDateTimeUtc(c.createdAt)}</td>
                <td className="py-1">
                  <RevokeButton id={c.id} />
                </td>
              </tr>
            ))}
            {credentials.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-2 text-ink-faint">
                  No credentials stored yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <p className="mt-3 text-[11px] text-ink-faint">
          Secrets are AES-256-GCM encrypted at rest and write-only after save. The UI shows a
          one-way fingerprint only.
        </p>
      </section>
    </div>
  );
}

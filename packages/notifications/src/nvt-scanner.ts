/**
 * Automated NeverFuckingTrade (NFT Trencher) eligibility scanner & Discord alerts.
 * Periodically or on-demand sweeps mints for the look-forward window (default 24h),
 * checks wallet eligibility with OpenSea SIWE passes, and pushes rich, character-safe
 * embeds to the configured Discord webhook.
 */

import { AppError, formatDateTimeGmt7 } from "@hoodmint/core";
import {
  type Db,
  findCredentialByType,
  findCredentialsByType,
  getCredentialSecret,
  getSetting,
  listWallets,
  setSetting,
  updateCredentialSecret,
} from "@hoodmint/db";
import { getLogger } from "@hoodmint/observability";
import { NvtClient, type NvtMint } from "@hoodmint/providers";
import { createDiscordAdapter } from "./channels.ts";
import {
  type DiscordEmbed,
  type DiscordEmbedField,
  formatCountdown,
  formatDiscordRelativeTime,
  sanitizeDiscordEmbed,
  truncateDiscordString,
} from "./render.ts";

const log = getLogger("nvt-scanner");

export interface NvtDiscordScanSettings {
  readonly enabled: boolean;
  readonly periodMinutes: number; // default 60 (hourly)
  readonly lookForwardHours: number; // default 24 (next 24 hours)
  readonly notifyWhitelistHits?: boolean | undefined; // default true
  readonly notifyUpcomingDigest?: boolean | undefined; // default false
  readonly lastRunAt?: string | undefined;
  readonly lastAlertCount?: number | undefined;
  readonly lastStatus?: "ok" | "error" | "warning" | undefined;
  readonly lastErrorMessage?: string | undefined;
  readonly lastAlertedKeys?: readonly string[] | undefined;
}

export interface NvtScanResult {
  readonly ok: boolean;
  readonly message: string;
  readonly dropsFound: number;
  readonly alertedCount: number;
  readonly warning?: string | undefined;
  readonly errors?: readonly string[] | undefined;
}

export const DEFAULT_NVT_SCAN_SETTINGS: NvtDiscordScanSettings = {
  enabled: true,
  periodMinutes: 60,
  lookForwardHours: 24,
  notifyWhitelistHits: true,
  notifyUpcomingDigest: false,
};

/**
 * Builds visually clean, character-safe Discord embeds for upcoming drops within the window.
 * Strictly adheres to Discord's 4,000 char embed description and 6,000 char total limits.
 */
export function buildUpcomingDigestEmbeds(
  mints: readonly NvtMint[],
  options: { lookForwardHours: number; nowIso: string },
): DiscordEmbed[] {
  const sorted = [...mints].sort((a, b) => {
    const aTime = a.next_stage?.start ? new Date(a.next_stage.start).getTime() : 0;
    const bTime = b.next_stage?.start ? new Date(b.next_stage.start).getTime() : 0;
    return aTime - bTime;
  });

  const embeds: DiscordEmbed[] = [];
  const chunkSize = 8;

  for (let i = 0; i < sorted.length && embeds.length < 5; i += chunkSize) {
    const slice = sorted.slice(i, i + chunkSize);
    const partNum = Math.floor(i / chunkSize) + 1;
    const totalParts = Math.ceil(sorted.length / chunkSize);

    const lines: string[] = [];
    for (const m of slice) {
      const stage = m.next_stage ?? m.stages[0];
      const stageStart = stage?.start ? new Date(stage.start).getTime() : 0;
      const relTime = stageStart > 0 ? formatDiscordRelativeTime(stageStart) : "soon";
      const gmt7Time =
        stageStart > 0 ? formatDateTimeGmt7(new Date(stageStart).toISOString()) : "TBD";
      const priceDisplay =
        stage?.price === 0
          ? "FREE"
          : stage?.price != null
            ? `${stage.price} ${stage.currency ?? "ETH"}`
            : "—";
      const link =
        m.links.mint ||
        m.links.opensea ||
        (m.slug ? `https://opensea.io/collection/${m.slug}` : "");
      const nameFormatted = link
        ? `[${truncateDiscordString(m.name, 35)}](${link})`
        : `**${truncateDiscordString(m.name, 35)}**`;
      const tierBadge =
        m.tier === "hot" ? "🔥 HOT" : m.tier === "warm" ? "⚡ WARM" : (m.tier?.toUpperCase() ?? "");

      lines.push(
        `• ${nameFormatted} (\`${m.chain.toUpperCase()}\`${tierBadge ? ` · ${tierBadge}` : ""})\n  └ **${truncateDiscordString(stage?.label ?? "Stage", 25)}** · Price: \`${priceDisplay}\` · Starts: **${gmt7Time} GMT+7** (${relTime})`,
      );
    }

    const titleText =
      totalParts > 1
        ? `📋 UPCOMING DROPS (Next ${options.lookForwardHours}h) · Part ${partNum}/${totalParts}`
        : `📋 UPCOMING DROPS (Next ${options.lookForwardHours}h) · HoodMint Radar`;

    const embed: DiscordEmbed = {
      title: titleText,
      description: lines.join("\n\n"),
      color: 0x00f0ff,
      fields: [],
      footer: { text: "HoodMint Radar · GMT+7 · NeverFuckingTrade" },
      timestamp: options.nowIso,
    };

    embeds.push(sanitizeDiscordEmbed(embed));
  }

  return embeds;
}

/**
 * Executes a scan pass for NVT mints within the lookForwardHours window,
 * checks eligibility across all accounts, and sends rich Discord embeds.
 */
export async function runNvtDiscordScanPass(
  db: Db,
  masterKey: string,
  options?: {
    nvtApiKey?: string | undefined;
    nvtBaseUrl?: string | undefined;
    forceSend?: boolean | undefined;
    sendUpcomingDigest?: boolean | undefined;
  },
): Promise<NvtScanResult> {
  // 1. Resolve Discord Webhook
  const webhookCred = await findCredentialByType(db, "nvt_discord_webhook");
  if (!webhookCred) {
    return {
      ok: false,
      message: "Discord webhook URL is not configured. Add webhook in Admin -> NeverFuckingTrade.",
      dropsFound: 0,
      alertedCount: 0,
    };
  }

  const webhookUrl = await getCredentialSecret(db, webhookCred.id, masterKey);
  if (!webhookUrl || webhookUrl.trim() === "") {
    return {
      ok: false,
      message: "Discord webhook secret could not be decrypted.",
      dropsFound: 0,
      alertedCount: 0,
    };
  }

  // 2. Resolve NVT API Key
  let apiKey = options?.nvtApiKey;
  if (!apiKey) {
    const keyCred = await findCredentialByType(db, "nvt_api_key");
    if (keyCred) {
      apiKey = await getCredentialSecret(db, keyCred.id, masterKey);
    }
  }

  if (!apiKey || apiKey.trim() === "") {
    return {
      ok: false,
      message: "NeverFuckingTrade API key is not configured.",
      dropsFound: 0,
      alertedCount: 0,
    };
  }

  // 3. Load scan settings
  const storedSettings = await getSetting<NvtDiscordScanSettings>(db, "nvt_scan_settings");
  const settings: NvtDiscordScanSettings = {
    ...DEFAULT_NVT_SCAN_SETTINGS,
    ...(storedSettings ?? {}),
  };

  const lookForwardHours = settings.lookForwardHours || 24;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const windowEnd = now + lookForwardHours * 3_600_000;

  const client = new NvtClient({
    apiKey,
    baseUrl: options?.nvtBaseUrl ?? "https://cdn.neverfuckingtrade.com/api/v1",
  });

  const discordAdapter = createDiscordAdapter();
  const errors: string[] = [];

  try {
    // 4. Fetch mints from NVT
    const mintsResult = await client.getMints();
    const allMints = mintsResult.mints;

    // Filter mints relevant to [now - 30min, now + lookForwardHours]
    const relevantMints = allMints.filter((m) => {
      if (m.status === "live") return true;
      if (m.status === "sold_out" || m.status === "ended") return false;
      return m.stages.some((stage) => {
        const stageStart = new Date(stage.start).getTime();
        const stageEnd = stage.end ? new Date(stage.end).getTime() : undefined;
        if (stageEnd !== undefined && stageEnd < now) return false;
        return stageStart <= windowEnd;
      });
    });

    // 5. Gather accounts (NVT profile, NVT wallets, tracked wallets)
    const accountsMap = new Map<string, { address: string; label: string }>();

    // NVT profile & wallets
    try {
      const me = await client.getMe();
      if (me.address?.startsWith("0x")) {
        accountsMap.set(me.address.toLowerCase(), {
          address: me.address,
          label: "NVT Primary",
        });
      } else if (me.profile?.startsWith("0x")) {
        accountsMap.set(me.profile.toLowerCase(), {
          address: me.profile,
          label: "NVT Profile",
        });
      }
      if (me.wallets) {
        for (const w of me.wallets) {
          const addr = typeof w === "string" ? w : w.a;
          if (addr?.startsWith("0x")) {
            const lower = addr.toLowerCase();
            if (!accountsMap.has(lower)) {
              accountsMap.set(lower, {
                address: addr,
                label: typeof w === "object" && w.primary ? "NVT Primary" : "NVT Wallet",
              });
            }
          }
        }
      }
    } catch (err) {
      log.warn({ err }, "could not load NVT /me profile during scan");
    }

    // Tracked wallets in Radar
    try {
      const tracked = await listWallets(db);
      for (const t of tracked) {
        const lower = t.address.toLowerCase();
        if (!accountsMap.has(lower)) {
          accountsMap.set(lower, {
            address: t.address,
            label: t.label ? `${t.label} (Tracked)` : "Tracked Wallet",
          });
        }
      }
    } catch (err) {
      log.warn({ err }, "could not load tracked wallets during scan");
    }

    const accounts = [...accountsMap.values()];

    // 6. Resolve OpenSea Pass credentials
    const passCreds = await findCredentialsByType(db, "nvt_opensea_pass").catch(() => []);
    const passMap = new Map<string, { pass: string; id: string; expiresAt?: Date | null }>();
    for (const cred of passCreds) {
      try {
        const pass = await getCredentialSecret(db, cred.id, masterKey);
        if (pass) {
          const addr = (cred.metadata as { address?: string } | null)?.address?.toLowerCase();
          if (addr) {
            passMap.set(addr, { pass, id: cred.id, expiresAt: cred.expiresAt });
          }
          if (passCreds.length === 1 && !passMap.has("*")) {
            passMap.set("*", { pass, id: cred.id, expiresAt: cred.expiresAt });
          }
        }
      } catch (err) {
        log.warn({ err, credentialId: cred.id }, "could not decrypt OpenSea pass");
      }
    }

    let authWarning: string | undefined;
    let anyPassFound = false;

    // 7. Whitelist scan for accounts against relevant candidate drops
    const wlMap = new Map<string, Map<string, string[]>>();
    const candidateSlugs = relevantMints.map((m) => m.slug).filter(Boolean);

    for (const account of accounts) {
      const passInfo = passMap.get(account.address.toLowerCase()) ?? passMap.get("*");
      if (passInfo) anyPassFound = true;

      try {
        const scanRes = await client.scanWl({
          address: account.address,
          ...(candidateSlugs.length > 0 ? { slugs: candidateSlugs } : {}),
          ...(passInfo?.pass ? { openSeaPass: passInfo.pass } : {}),
        });

        // Automatically update stored pass expiry if refreshed by NVT
        if (scanRes.pass && passInfo?.id) {
          const freshHours = scanRes.hours ?? 72;
          await updateCredentialSecret(db, passInfo.id, {
            secret: scanRes.pass,
            masterKey,
            expiresAt: new Date(Date.now() + freshHours * 3600 * 1000),
            metadata: {
              address: account.address.toLowerCase(),
              hours: freshHours,
              lastRefreshedAt: new Date().toISOString(),
            },
          }).catch(() => undefined);
        }

        if (scanRes.listed && scanRes.listed.length > 0) {
          const accountHits = new Map<string, string[]>();
          for (const item of scanRes.listed) {
            const stages = item.stages.map((s) => s.label || s.kind || "Whitelisted");
            if (item.slug) accountHits.set(item.slug.toLowerCase(), stages);
            if (item.contract) accountHits.set(item.contract.toLowerCase(), stages);
          }
          wlMap.set(account.address.toLowerCase(), accountHits);
        }
      } catch (err) {
        if (
          err instanceof AppError &&
          (err.category === "AuthRequired" || err.statusCode === 401)
        ) {
          authWarning =
            "OpenSea Pass is missing or expired. Sign in with your wallet at /admin/nvt to activate 3-day whitelist checks.";
        }
        log.warn({ err, address: account.address }, "whitelist scan failed for account");
      }
    }

    if (!anyPassFound && !authWarning) {
      authWarning =
        "OpenSea Pass is not configured. Gated allowlists require signing in with your wallet at /admin/nvt (pass valid for 3 days).";
    }

    // 8. Find eligible hits
    interface EligibleHit {
      readonly mint: NvtMint;
      readonly stageLabel: string;
      readonly stageKind: string;
      readonly stagePrice: string | number | null;
      readonly stageCurrency: string;
      readonly stageStart: string;
      readonly account: { address: string; label: string };
      readonly key: string;
    }

    const hits: EligibleHit[] = [];
    const lastAlertedSet = new Set(settings.lastAlertedKeys ?? []);

    for (const mint of relevantMints) {
      for (const account of accounts) {
        const accountHits = wlMap.get(account.address.toLowerCase());
        const eligibleStages = accountHits
          ? ((mint.slug ? accountHits.get(mint.slug.toLowerCase()) : undefined) ??
            (mint.contract ? accountHits.get(mint.contract.toLowerCase()) : undefined))
          : undefined;

        for (const stage of mint.stages) {
          const stageStart = new Date(stage.start).getTime();
          const stageEnd = stage.end ? new Date(stage.end).getTime() : undefined;
          if (stageEnd !== undefined && stageEnd < now) continue;
          if (stageStart > windowEnd) continue;

          // Is account eligible for this stage?
          const isEligible =
            eligibleStages?.some(
              (s) =>
                s.toLowerCase() === stage.label.toLowerCase() ||
                s.toLowerCase() === stage.kind.toLowerCase(),
            ) ?? false;

          if (isEligible) {
            const key = `${mint.id}:${stage.label}:${account.address.toLowerCase()}`;
            if (!options?.forceSend && lastAlertedSet.has(key)) {
              continue;
            }
            hits.push({
              mint,
              stageLabel: stage.label,
              stageKind: stage.kind,
              stagePrice: stage.price ?? null,
              stageCurrency: stage.currency ?? "ETH",
              stageStart: stage.start,
              account,
              key,
            });
          }
        }
      }
    }

    let alertedCount = 0;
    const newAlertedKeys = new Set(lastAlertedSet);

    // 9. Dispatch Whitelist alerts to Discord
    const shouldSendWl = settings.notifyWhitelistHits !== false;
    if (shouldSendWl && hits.length > 0) {
      const toSend = hits.slice(0, 10);
      for (const hit of toSend) {
        const stageStartMs = new Date(hit.stageStart).getTime();
        const relTime = formatDiscordRelativeTime(stageStartMs);
        const countdown = formatCountdown(hit.stageStart, nowIso);
        const mintUrl =
          hit.mint.links.mint ||
          hit.mint.links.opensea ||
          (hit.mint.slug ? `https://opensea.io/collection/${hit.mint.slug}/overview` : undefined);

        const fields: DiscordEmbedField[] = [
          {
            name: "Stage",
            value: `${truncateDiscordString(hit.stageLabel, 40)} (${hit.stageKind.toUpperCase()})`,
            inline: true,
          },
          {
            name: "Price",
            value:
              hit.stagePrice === 0
                ? "`FREE`"
                : hit.stagePrice !== null
                  ? `\`${hit.stagePrice} ${hit.stageCurrency}\``
                  : "`Unknown`",
            inline: true,
          },
          {
            name: "Wallet",
            value: `\`${hit.account.address.slice(0, 6)}...${hit.account.address.slice(-4)}\` (${hit.account.label})`,
            inline: true,
          },
          {
            name: "Chain",
            value: `\`${hit.mint.chain.toUpperCase()}\``,
            inline: true,
          },
          {
            name: "Tier",
            value:
              hit.mint.tier === "hot"
                ? "🔥 `HOT`"
                : hit.mint.tier === "warm"
                  ? "⚡ `WARM`"
                  : `\`${(hit.mint.tier ?? "STANDARD").toUpperCase()}\``,
            inline: true,
          },
          {
            name: "Supply",
            value: `${hit.mint.supply ?? "Open"} (${hit.mint.minted} minted)`,
            inline: true,
          },
          {
            name: "Starts At (GMT+7)",
            value: `${formatDateTimeGmt7(hit.stageStart)} GMT+7 · ${relTime || countdown || "soon"}`,
            inline: false,
          },
        ];

        const linkParts: string[] = [];
        if (hit.mint.links.mint) linkParts.push(`[🌐 Mint Site](${hit.mint.links.mint})`);
        if (hit.mint.links.opensea || hit.mint.slug) {
          linkParts.push(
            `[⛵ OpenSea](${hit.mint.links.opensea || `https://opensea.io/collection/${hit.mint.slug}`})`,
          );
        }
        if (hit.mint.links.x) linkParts.push(`[🐦 Twitter/X](${hit.mint.links.x})`);
        if (linkParts.length > 0) {
          fields.push({
            name: "Direct Links",
            value: linkParts.join(" • "),
            inline: false,
          });
        }

        const rawEmbed: DiscordEmbed = {
          title: `🎯 NVT WL HIT: ${truncateDiscordString(hit.mint.name, 100)}`,
          ...(mintUrl ? { url: mintUrl } : {}),
          color: 0x39ff88, // Acid green
          description: `Your account **${hit.account.label}** is whitelisted for **${hit.mint.name}** starting within the next ${lookForwardHours}h!`,
          fields,
          footer: { text: "HoodMint Radar · NeverFuckingTrade · GMT+7" },
          timestamp: nowIso,
        };

        const safeEmbed = sanitizeDiscordEmbed(rawEmbed);
        const sendRes = await discordAdapter.send({ url: webhookUrl }, safeEmbed);
        if (sendRes.ok) {
          alertedCount++;
          newAlertedKeys.add(hit.key);
        } else {
          errors.push(`Discord delivery failed for ${hit.mint.name}: ${sendRes.errorCode}`);
        }
      }
    }

    // 10. Dispatch Upcoming Drops Digest (if requested or configured)
    const shouldSendDigest = options?.sendUpcomingDigest || settings.notifyUpcomingDigest;
    if (shouldSendDigest && relevantMints.length > 0) {
      const digestEmbeds = buildUpcomingDigestEmbeds(relevantMints, {
        lookForwardHours,
        nowIso,
      });

      for (const embed of digestEmbeds) {
        const sendRes = await discordAdapter.send({ url: webhookUrl }, embed);
        if (sendRes.ok) {
          alertedCount++;
        } else {
          errors.push(`Discord digest delivery failed: ${sendRes.errorCode}`);
        }
      }
    }

    // 11. Update settings & persist state
    const trimmedKeys = [...newAlertedKeys].slice(-200);
    const updatedSettings: NvtDiscordScanSettings = {
      ...settings,
      lastRunAt: nowIso,
      lastAlertCount: alertedCount,
      lastStatus: errors.length > 0 ? "error" : authWarning ? "warning" : "ok",
      lastErrorMessage:
        errors.length > 0 ? errors.join("; ") : authWarning ? authWarning : undefined,
      lastAlertedKeys: trimmedKeys,
    };
    await setSetting(db, "nvt_scan_settings", updatedSettings);

    // 12. Formulate clear result message
    let resultMessage: string;
    if (hits.length > 0) {
      resultMessage = `Scan complete: ${relevantMints.length} upcoming drops evaluated, ${hits.length} whitelist hit(s) found, ${alertedCount} Discord alert(s) sent.`;
    } else if (authWarning) {
      resultMessage = `Scan complete: ${relevantMints.length} upcoming drops evaluated (0 WL hits). ⚠️ ${authWarning}`;
    } else {
      resultMessage = `Scan complete: ${relevantMints.length} upcoming drops evaluated. Checked with active OpenSea pass: 0 eligible gated stages found in next ${lookForwardHours}h.`;
    }

    return {
      ok: true,
      message: resultMessage,
      dropsFound: relevantMints.length,
      alertedCount,
      ...(authWarning ? { warning: authWarning } : {}),
      ...(errors.length > 0 ? { errors } : {}),
    };
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Scan failed";
    log.error({ err: error }, "NVT Discord scan pass failed");
    await setSetting(db, "nvt_scan_settings", {
      ...settings,
      lastRunAt: nowIso,
      lastStatus: "error",
      lastErrorMessage: errMessage,
    }).catch(() => undefined);
    return {
      ok: false,
      message: `Scan failed: ${errMessage}`,
      dropsFound: 0,
      alertedCount: 0,
      errors: [errMessage],
    };
  }
}

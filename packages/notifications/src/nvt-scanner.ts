/**
 * Automated NeverFuckingTrade (NFT Trencher) eligibility scanner & Discord alerts.
 * Periodically or on-demand sweeps mints for the look-forward window (default 24h),
 * checks wallet eligibility, and pushes rich embeds to the configured Discord webhook.
 */

import { formatDateTimeGmt7 } from "@hoodmint/core";
import {
  type Db,
  findCredentialByType,
  getCredentialSecret,
  getSetting,
  listWallets,
  setSetting,
} from "@hoodmint/db";
import { getLogger } from "@hoodmint/observability";
import { NvtClient, type NvtMint } from "@hoodmint/providers";
import { createDiscordAdapter } from "./channels.ts";
import { type DiscordEmbed, formatCountdown } from "./render.ts";

const log = getLogger("nvt-scanner");

export interface NvtDiscordScanSettings {
  readonly enabled: boolean;
  readonly periodMinutes: number; // default 60 (hourly)
  readonly lookForwardHours: number; // default 24 (next 24 hours)
  readonly lastRunAt?: string | undefined;
  readonly lastAlertCount?: number | undefined;
  readonly lastStatus?: "ok" | "error" | undefined;
  readonly lastErrorMessage?: string | undefined;
  readonly lastAlertedKeys?: readonly string[] | undefined;
}

export interface NvtScanResult {
  readonly ok: boolean;
  readonly message: string;
  readonly dropsFound: number;
  readonly alertedCount: number;
  readonly errors?: readonly string[] | undefined;
}

export const DEFAULT_NVT_SCAN_SETTINGS: NvtDiscordScanSettings = {
  enabled: true,
  periodMinutes: 60,
  lookForwardHours: 24,
};

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
  },
): Promise<NvtScanResult> {
  // 1. Resolve Discord Webhook
  const webhookCred = await findCredentialByType(db, "nvt_discord_webhook");
  if (!webhookCred) {
    return {
      ok: false,
      message: "Discord webhook URL is not configured.",
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

    // 6. Whitelist scan for accounts against relevant candidate drops
    // Map<address, Map<slugOrContract, string[]>>
    const wlMap = new Map<string, Map<string, string[]>>();
    const candidateSlugs = relevantMints.map((m) => m.slug).filter(Boolean);

    for (const account of accounts) {
      try {
        const scanRes = await client.scanWl({
          address: account.address,
          ...(candidateSlugs.length > 0 ? { slugs: candidateSlugs } : {}),
        });
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
        log.warn({ err, address: account.address }, "whitelist scan failed for account");
      }
    }

    // 7. Find eligible hits & format Discord embeds
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

        // Check each stage of the mint
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
              // Already alerted recently
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

    // 8. Dispatch Discord embeds (capped at 10 embeds per pass to prevent rate limiting)
    const toSend = hits.slice(0, 10);
    for (const hit of toSend) {
      const countdown = formatCountdown(hit.stageStart, nowIso);
      const mintUrl =
        hit.mint.links.mint ||
        hit.mint.links.opensea ||
        (hit.mint.slug ? `https://opensea.io/collection/${hit.mint.slug}/overview` : undefined);

      const embed: DiscordEmbed = {
        title: `🎯 NVT WL HIT: ${hit.mint.name}`,
        ...(mintUrl ? { url: mintUrl } : {}),
        color: 0x39ff88, // Acid green
        description: `Your account **${hit.account.label}** is whitelisted for **${hit.mint.name}** (${hit.mint.chain.toUpperCase()}) starting within the next ${lookForwardHours}h!`,
        fields: [
          {
            name: "Stage",
            value: `${hit.stageLabel} (${hit.stageKind.toUpperCase()})`,
            inline: true,
          },
          {
            name: "Price",
            value:
              hit.stagePrice === 0
                ? "FREE"
                : hit.stagePrice !== null
                  ? `${hit.stagePrice} ${hit.stageCurrency}`
                  : "Unknown",
            inline: true,
          },
          {
            name: "Wallet",
            value: `\`${hit.account.address.slice(0, 6)}...${hit.account.address.slice(-4)}\``,
            inline: true,
          },
          {
            name: "Starts At (GMT+7)",
            value: `${formatDateTimeGmt7(hit.stageStart)} (${countdown ?? "soon"})`,
            inline: false,
          },
          {
            name: "Supply",
            value: `${hit.mint.supply ?? "Open"} (Minted: ${hit.mint.minted})`,
            inline: true,
          },
          {
            name: "Chain",
            value: hit.mint.chain.toUpperCase(),
            inline: true,
          },
        ],
        footer: { text: "HoodMint Radar · NeverFuckingTrade" },
        timestamp: nowIso,
      };

      const sendRes = await discordAdapter.send({ url: webhookUrl }, embed);
      if (sendRes.ok) {
        alertedCount++;
        newAlertedKeys.add(hit.key);
      } else {
        errors.push(`Discord delivery failed for ${hit.mint.name}: ${sendRes.errorCode}`);
      }
    }

    // 9. Update settings
    // Keep max 200 alerted keys to bound storage
    const trimmedKeys = [...newAlertedKeys].slice(-200);
    const updatedSettings: NvtDiscordScanSettings = {
      ...settings,
      lastRunAt: nowIso,
      lastAlertCount: alertedCount,
      lastStatus: errors.length > 0 ? "error" : "ok",
      ...(errors.length > 0 ? { lastErrorMessage: errors.join("; ") } : {}),
      lastAlertedKeys: trimmedKeys,
    };
    await setSetting(db, "nvt_scan_settings", updatedSettings);

    return {
      ok: true,
      message: `Scan complete: ${relevantMints.length} upcoming/live drops evaluated, ${hits.length} whitelist hits found, ${alertedCount} Discord alerts sent.`,
      dropsFound: relevantMints.length,
      alertedCount,
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
      message: `Scan error: ${errMessage}`,
      dropsFound: 0,
      alertedCount: 0,
      errors: [errMessage],
    };
  }
}

/**
 * Outbox dispatcher (PRD §7.4): claims due alerts, delivers to every enabled
 * channel, records attempts with sanitized responses, and only marks sent
 * after provider acknowledgement. Retries are independent of discovery.
 */
import type { Db } from "@hoodmint/db";
import {
  claimDueAlerts,
  getCredentialSecret,
  markAlertFailed,
  markAlertSent,
  recordAttempt,
} from "@hoodmint/db";
import { metrics } from "@hoodmint/observability";
import {
  createDiscordAdapter,
  createTelegramAdapter,
  createWebhookAdapter,
  createWebPushAdapter,
  type DiscordConfig,
  type TelegramConfig,
  type WebhookConfig,
  type WebPushConfig,
  type WebPushVapidDetails,
} from "./channels.ts";
import type { DiscordEmbed, DiscordEmbedField } from "./render.ts";

// Same untyped-jsonb-guard pattern as isDiscordEmbed below, for the
// unsealed {endpoint, p256dh, auth} config a web_push channel stores
// directly on alert_channels.config (no credentialId — see channels.ts's
// createWebPushAdapter doc comment on why these aren't sealed like a
// bearer token).
function isWebPushSubscriptionConfig(value: unknown): value is WebPushConfig {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.endpoint === "string" && typeof v.p256dh === "string" && typeof v.auth === "string"
  );
}

// alert.payload is untyped jsonb (whatever the enqueuing worker put there) —
// this is a runtime guard, not a cast, before trusting it as a DiscordEmbed.
function isDiscordEmbed(value: unknown): value is DiscordEmbed {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.title === "string" &&
    typeof v.color === "number" &&
    Array.isArray(v.fields) &&
    v.fields.every(
      (f): f is DiscordEmbedField =>
        typeof f === "object" &&
        f !== null &&
        typeof (f as Record<string, unknown>).name === "string" &&
        typeof (f as Record<string, unknown>).value === "string",
    ) &&
    typeof v.footer === "object" &&
    v.footer !== null &&
    typeof (v.footer as Record<string, unknown>).text === "string" &&
    typeof v.timestamp === "string"
  );
}

export interface DispatchDeps {
  readonly db: Db;
  readonly masterKey: string;
  readonly claimLimit?: number;
  /** Opt-in, like X signals — omit to leave web_push channels misconfigured
   *  rather than throwing (matches every other channel's fail-closed
   *  posture when its config is incomplete). */
  readonly webPushVapid?: WebPushVapidDetails;
}

export interface DispatchSummary {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
}

export async function dispatchDueAlerts(deps: DispatchDeps): Promise<DispatchSummary> {
  const { db, masterKey } = deps;
  const telegram = createTelegramAdapter();
  const webhook = createWebhookAdapter();
  const discord = createDiscordAdapter();
  const webPush = deps.webPushVapid !== undefined ? createWebPushAdapter(deps.webPushVapid) : null;

  const alerts = await claimDueAlerts(db, new Date(), deps.claimLimit ?? 20);
  let sent = 0;
  let failed = 0;

  for (const alert of alerts) {
    const text =
      typeof alert.payload.text === "string" ? alert.payload.text : JSON.stringify(alert.payload);
    let anySuccess = false;
    let lastError = "no_channels";

    for (const channel of alert.channels) {
      let result: {
        ok: boolean;
        sanitizedResponse: string;
        errorCode?: string;
        latencyMs: number;
      } | null = null;
      if (channel.kind === "telegram") {
        const secret =
          channel.credentialId !== null
            ? await getCredentialSecret(db, channel.credentialId, masterKey)
            : undefined;
        const chatId = typeof channel.config.chatId === "string" ? channel.config.chatId : null;
        const config: TelegramConfig | null =
          secret !== undefined && chatId !== null ? { botToken: secret, chatId } : null;
        if (config !== null) {
          result = await telegram.send(config, text);
        }
      } else if (channel.kind === "webhook") {
        const secret =
          channel.credentialId !== null
            ? await getCredentialSecret(db, channel.credentialId, masterKey)
            : undefined;
        const config: WebhookConfig | null = secret?.startsWith("https://")
          ? { url: secret }
          : null;
        if (config !== null) {
          result = await webhook.send(config, text, {
            alertType: alert.alertType,
            thresholdMinutes: alert.thresholdMinutes,
          });
        }
      } else if (channel.kind === "discord") {
        const secret =
          channel.credentialId !== null
            ? await getCredentialSecret(db, channel.credentialId, masterKey)
            : undefined;
        const config: DiscordConfig | null = secret?.startsWith("https://")
          ? { url: secret }
          : null;
        // Prefer the rich embed the enqueuing worker precomputed; fall back
        // to a plain-description embed from the flat text for any outbox
        // row enqueued before this feature (or by a future caller that
        // hasn't been updated to also set payload.embed).
        const embed: DiscordEmbed = isDiscordEmbed(alert.payload.embed)
          ? alert.payload.embed
          : {
              title: "HoodMint Radar alert",
              color: 0x8a8f98,
              fields: [{ name: "Details", value: text.slice(0, 1024) }],
              footer: { text: "HoodMint Radar" },
              timestamp: new Date().toISOString(),
            };
        if (config !== null) {
          result = await discord.send(config, embed);
        }
      } else if (channel.kind === "web_push") {
        // Unlike telegram/webhook/discord's one-shared-destination-per-
        // channel-row model, each subscribed browser is its own channel
        // row — the subscription itself lives in channel.config (see
        // isWebPushSubscriptionConfig), not behind a credentialId, since
        // it's per-device cryptographic material captured by the client-
        // side subscribe flow, not an admin-typed bearer secret.
        const subscription = isWebPushSubscriptionConfig(channel.config) ? channel.config : null;
        if (webPush !== null && subscription !== null) {
          const embed: DiscordEmbed | undefined = isDiscordEmbed(alert.payload.embed)
            ? alert.payload.embed
            : undefined;
          result = await webPush.send(subscription, {
            title: embed?.title ?? "HoodMint Radar alert",
            body: text.slice(0, 300),
            ...(embed?.url !== undefined ? { url: embed.url } : {}),
          });
        }
      }

      if (result === null) {
        // Channel misconfigured (missing sealed secret) — permanent for this attempt.
        result = {
          ok: false,
          sanitizedResponse: "channel secret missing",
          errorCode: "PermanentConfig",
          latencyMs: 0,
        };
      }

      await recordAttempt(db, {
        outboxId: alert.id,
        channelKind: channel.kind,
        status: result.ok ? "success" : "failure",
        latencyMs: result.latencyMs,
        ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
        sanitizedResponse: result.sanitizedResponse,
      });
      metrics().inc("hoodmint_alerts_total", {
        channel: channel.kind,
        outcome: result.ok ? "success" : "failure",
      });

      if (result.ok) {
        anySuccess = true;
      } else {
        lastError = result.errorCode ?? "unknown";
      }
    }

    if (anySuccess) {
      await markAlertSent(db, alert.id, "acknowledged");
      sent += 1;
    } else {
      await markAlertFailed(db, alert.id, lastError, undefined);
      failed += 1;
    }
  }

  return { claimed: alerts.length, sent, failed };
}

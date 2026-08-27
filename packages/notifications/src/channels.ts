/**
 * Channel adapters (PRD §7.4): every adapter implements validate, sendTest,
 * and send. Webhooks go through the SSRF guard; responses are truncated and
 * sanitized before storage; redirects never followed.
 */
import { AppError } from "@hoodmint/core";
import { redactUrl } from "@hoodmint/secrets";
import * as webpush from "web-push";
import type { DiscordEmbed } from "./render.ts";
import { assertSafeWebhookUrl } from "./ssrf.ts";

export type FetchLike = (url: string, init: TimedRequestInit) => Promise<Response>;

interface TimedRequestInit extends RequestInit {
  timeoutMs?: number;
}

export const DEFAULT_FETCH: FetchLike = (url, init) => {
  const { timeoutMs = 10_000, ...rest } = init;
  return fetch(url, {
    ...rest,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
};

export interface TelegramConfig {
  readonly botToken: string;
  readonly chatId: string;
}

export interface WebhookConfig {
  readonly url: string;
}

export interface SendResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly sanitizedResponse: string;
  readonly errorCode?: string;
}

function sanitizeBody(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 300);
}

async function timedSend(
  url: string,
  init: TimedRequestInit,
  fetchImpl: FetchLike,
): Promise<SendResult> {
  const started = Date.now();
  try {
    const response = await fetchImpl(url, init);
    const latencyMs = Date.now() - started;
    const body = await response.text().catch(() => "");
    if (!response.ok) {
      return {
        ok: false,
        latencyMs,
        sanitizedResponse: sanitizeBody(body),
        errorCode: `http_${response.status}`,
      };
    }
    return { ok: true, latencyMs, sanitizedResponse: sanitizeBody(body) };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = error instanceof Error ? error.message : "network error";
    const categorized = /abort|timeout/i.test(message)
      ? "timeout"
      : /redirect/i.test(message)
        ? "redirect_blocked"
        : "network_error";
    return {
      ok: false,
      latencyMs,
      sanitizedResponse: sanitizeBody(redactUrl(message)),
      errorCode: categorized,
    };
  }
}

export interface TelegramAdapter {
  validate(config: TelegramConfig): AppError | null;
  sendTest(config: TelegramConfig): Promise<SendResult>;
  send(config: TelegramConfig, text: string): Promise<SendResult>;
}

export function createTelegramAdapter(fetchImpl: FetchLike = DEFAULT_FETCH): TelegramAdapter {
  const endpoint = (config: TelegramConfig, method: string): string =>
    `https://api.telegram.org/bot${config.botToken}/${method}`;

  const deliver = async (config: TelegramConfig, text: string): Promise<SendResult> => {
    const result = await timedSend(
      endpoint(config, "sendMessage"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.chatId,
          text,
          disable_web_page_preview: true,
        }),
        timeoutMs: 10_000,
      },
      fetchImpl,
    );
    // Telegram body includes ok:true; strip any token fragments defensively.
    return {
      ...result,
      sanitizedResponse: result.sanitizedResponse.replace(/\b\d{6,}:[\w-]{20,}\b/g, "[REDACTED]"),
    };
  };

  return {
    validate(config) {
      if (!/^\d{6,10}:[A-Za-z0-9_-]{30,}$/.test(config.botToken)) {
        return new AppError("PermanentConfig", "telegram bot token format is invalid");
      }
      if (!/^-?\d+$/.test(config.chatId) && !/^@[A-Za-z0-9_]{4,}$/.test(config.chatId)) {
        return new AppError("PermanentConfig", "telegram chat id format is invalid");
      }
      return null;
    },
    async sendTest(config) {
      return deliver(config, "HoodMint Radar test message — channel configured successfully.");
    },
    async send(config, text) {
      return deliver(config, text);
    },
  };
}

export interface DiscordConfig {
  readonly url: string;
}

// Discord webhook URLs are always this exact shape (per
// docs.discord.com/developers/resources/webhook) — a stricter early check
// than the generic webhook's, for a clearer error than "SSRF guard
// rejected it" when someone pastes the wrong URL.
const DISCORD_WEBHOOK_URL_PATTERN =
  /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export interface DiscordAdapter {
  validate(config: DiscordConfig): Promise<AppError | null>;
  sendTest(config: DiscordConfig): Promise<SendResult>;
  send(config: DiscordConfig, embed: DiscordEmbed): Promise<SendResult>;
}

/**
 * Rich Discord embed alerts — same SSRF-guarded outbound-only HTTPS POST as
 * the generic webhook adapter, no new trust surface (feature-backlog.md,
 * shipped 2026-08-22). `wait=false` (Discord's default) returns 204 with no
 * body on success, which timedSend already treats as ok via response.ok.
 */
export function createDiscordAdapter(
  fetchImpl: FetchLike = DEFAULT_FETCH,
  options: { dnsLookup?: (host: string) => Promise<{ address: string }[]> } = {},
): DiscordAdapter {
  const deliver = async (
    config: DiscordConfig,
    payload: Record<string, unknown>,
  ): Promise<SendResult> => {
    const guard = await assertSafeWebhookUrl(config.url, options);
    return timedSend(
      guard.toString(),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: 10_000,
      },
      fetchImpl,
    );
  };

  return {
    async validate(config) {
      const trimmed = config.url.trim();
      if (!DISCORD_WEBHOOK_URL_PATTERN.test(trimmed)) {
        return new AppError(
          "PermanentConfig",
          "not a Discord webhook URL (expected https://discord.com/api/webhooks/<id>/<token>)",
        );
      }
      try {
        await assertSafeWebhookUrl(trimmed);
        return null;
      } catch (error) {
        return error instanceof AppError
          ? error
          : new AppError("PermanentConfig", "webhook URL rejected");
      }
    },
    async sendTest(config) {
      try {
        return await deliver(config, {
          embeds: [
            {
              title: "HoodMint Radar test message",
              description: "Discord channel configured successfully.",
              color: 0x39ff88,
            },
          ],
        });
      } catch (error) {
        return {
          ok: false,
          latencyMs: 0,
          sanitizedResponse: error instanceof Error ? sanitizeBody(error.message) : "",
          errorCode: "ssrf_blocked",
        };
      }
    },
    async send(config, embed) {
      try {
        return await deliver(config, { embeds: [embed] });
      } catch (error) {
        return {
          ok: false,
          latencyMs: 0,
          sanitizedResponse: error instanceof Error ? sanitizeBody(error.message) : "",
          errorCode: "ssrf_blocked",
        };
      }
    },
  };
}

export interface WebPushConfig {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface WebPushVapidDetails {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

export interface WebPushAdapter {
  validate(config: WebPushConfig): Promise<AppError | null>;
  sendTest(config: WebPushConfig): Promise<SendResult>;
  send(
    config: WebPushConfig,
    payload: { title: string; body: string; url?: string },
  ): Promise<SendResult>;
}

/**
 * Browser push alerts (feature-backlog.md, shipped 2026-08-22): "buzz my
 * phone the instant a restricted stage opens" without a bot/Discord
 * server. Unlike Telegram/webhook/Discord — one admin-typed shared
 * destination per channel row — a push subscription's endpoint/keys come
 * from the *browser's* PushManager, captured by a client-side subscribe
 * flow (apps/web), not typed by an admin. The one shared VAPID keypair
 * (an operator-generated identity, not a per-channel secret) is set once
 * at adapter construction, matching web-push's own setVapidDetails model.
 *
 * The endpoint is FCM/Mozilla/etc-controlled in the normal flow, but
 * still gets the exact same assertSafeWebhookUrl SSRF guard the generic
 * webhook adapter uses before send() — the server makes a real outbound
 * HTTPS request to whatever endpoint is stored, and defense-in-depth
 * costs nothing here.
 */
export type SendPushLike = typeof webpush.sendNotification;

/**
 * `sendImpl` defaults to the real library call; tests inject a stub —
 * web-push has no fetch-injection seam of its own (it drives Node's
 * `https` module directly), so this is the same pattern as `FetchLike`
 * above, applied to the one adapter that needed its own version of it.
 */
export function createWebPushAdapter(
  vapidDetails: WebPushVapidDetails,
  sendImpl: SendPushLike = webpush.sendNotification,
): WebPushAdapter {
  webpush.setVapidDetails(vapidDetails.subject, vapidDetails.publicKey, vapidDetails.privateKey);

  const deliver = async (config: WebPushConfig, payloadJson: string): Promise<SendResult> => {
    await assertSafeWebhookUrl(config.endpoint);
    const started = Date.now();
    try {
      const result = await sendImpl(
        { endpoint: config.endpoint, keys: { p256dh: config.p256dh, auth: config.auth } },
        payloadJson,
        { timeout: 10_000, TTL: 60 * 60 },
      );
      return {
        ok: true,
        latencyMs: Date.now() - started,
        sanitizedResponse: sanitizeBody(result.body),
      };
    } catch (error) {
      const latencyMs = Date.now() - started;
      if (error instanceof webpush.WebPushError) {
        return {
          ok: false,
          latencyMs,
          sanitizedResponse: sanitizeBody(error.body),
          errorCode: `http_${error.statusCode}`,
        };
      }
      const message = error instanceof Error ? error.message : "push send failed";
      return {
        ok: false,
        latencyMs,
        sanitizedResponse: sanitizeBody(redactUrl(message)),
        errorCode: /abort|timeout/i.test(message) ? "timeout" : "network_error",
      };
    }
  };

  return {
    async validate(config) {
      if (config.p256dh === "" || config.auth === "") {
        return new AppError("PermanentConfig", "push subscription is missing encryption keys");
      }
      try {
        await assertSafeWebhookUrl(config.endpoint);
        return null;
      } catch (error) {
        return error instanceof AppError
          ? error
          : new AppError("PermanentConfig", "push subscription endpoint rejected");
      }
    },
    async sendTest(config) {
      try {
        return await deliver(
          config,
          JSON.stringify({
            title: "HoodMint Radar",
            body: "Test push — this device is configured successfully.",
          }),
        );
      } catch (error) {
        return {
          ok: false,
          latencyMs: 0,
          sanitizedResponse: error instanceof Error ? sanitizeBody(error.message) : "",
          errorCode: "ssrf_blocked",
        };
      }
    },
    async send(config, payload) {
      try {
        return await deliver(config, JSON.stringify(payload));
      } catch (error) {
        return {
          ok: false,
          latencyMs: 0,
          sanitizedResponse: error instanceof Error ? sanitizeBody(error.message) : "",
          errorCode: "ssrf_blocked",
        };
      }
    },
  };
}

export interface WebhookAdapter {
  validate(config: WebhookConfig): Promise<AppError | null>;
  sendTest(config: WebhookConfig): Promise<SendResult>;
  send(config: WebhookConfig, text: string, meta: Record<string, unknown>): Promise<SendResult>;
}

export function createWebhookAdapter(
  fetchImpl: FetchLike = DEFAULT_FETCH,
  options: { dnsLookup?: (host: string) => Promise<{ address: string }[]> } = {},
): WebhookAdapter {
  const deliver = async (
    config: WebhookConfig,
    payload: Record<string, unknown>,
  ): Promise<SendResult> => {
    const guard = await assertSafeWebhookUrl(config.url, options);
    return timedSend(
      guard.toString(),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: 10_000,
      },
      fetchImpl,
    );
  };

  return {
    async validate(config) {
      try {
        await assertSafeWebhookUrl(config.url);
        return null;
      } catch (error) {
        return error instanceof AppError
          ? error
          : new AppError("PermanentConfig", "webhook URL rejected");
      }
    },
    async sendTest(config) {
      try {
        return await deliver(config, { text: "HoodMint Radar test message", event: "test" });
      } catch (error) {
        return {
          ok: false,
          latencyMs: 0,
          sanitizedResponse: error instanceof Error ? sanitizeBody(error.message) : "",
          errorCode: "ssrf_blocked",
        };
      }
    },
    async send(config, text, meta) {
      try {
        // Slack-style text + Discord-style content for compatibility.
        return await deliver(config, { text, content: text, event: "alert", ...meta });
      } catch (error) {
        return {
          ok: false,
          latencyMs: 0,
          sanitizedResponse: error instanceof Error ? sanitizeBody(error.message) : "",
          errorCode: "ssrf_blocked",
        };
      }
    },
  };
}

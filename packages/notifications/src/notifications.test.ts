import { describe, expect, it } from "vitest";
import { WebPushError } from "web-push";
import {
  createDiscordAdapter,
  createTelegramAdapter,
  createWebhookAdapter,
  createWebPushAdapter,
} from "./channels.ts";
import { formatCountdown, renderAlertEmbed, renderAlertMessage } from "./render.ts";
import { assertSafeWebhookUrl, isPrivateAddress } from "./ssrf.ts";

const VAPID = {
  subject: "mailto:ops@example.test",
  // web-push validates these are real URL-safe base64 P-256 points/scalars
  // at setVapidDetails() time (it rejects malformed keys), so these are a
  // real throwaway keypair generated via webpush.generateVAPIDKeys() —
  // not a secret, not used for anything but this test.
  publicKey:
    "BBGUOhwSpWtIxXDzpVtVA6xCbXklDwxA5rkfVTVxQ50xKqCmII0CK7eEVvBTqbuWjBYRZFguVE9MiU7506u0NbE",
  privateKey: "vNL5suJGMfjiewivX4yAtjd5cgDieuiYxa0bX9P2Ok4",
};

const dns = (map: Record<string, string[]>) => async (host: string) =>
  (map[host] ?? []).map((address) => ({ address }));

describe("isPrivateAddress", () => {
  it("blocks loopback, private, link-local, and reserved ranges (v4+v6)", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.1.1",
      "0.0.0.0",
      "240.0.0.1",
      "::1",
      "fe80::1",
      "fd12::1",
      "ff02::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("assertSafeWebhookUrl", () => {
  it("accepts public https webhook targets", async () => {
    const url = await assertSafeWebhookUrl("https://hooks.example.com/x", {
      dnsLookup: dns({ "hooks.example.com": ["93.184.216.34"] }),
    });
    expect(url.hostname).toBe("hooks.example.com");
  });

  it("rejects http to public hosts", async () => {
    await expect(
      assertSafeWebhookUrl("http://hooks.example.com/x", {
        dnsLookup: dns({ "hooks.example.com": ["93.184.216.34"] }),
      }),
    ).rejects.toThrow(/https/);
  });

  it("rejects hostnames resolving to private space (SSRF via DNS rebinding vector)", async () => {
    await expect(
      assertSafeWebhookUrl("https://evil.internal/x", {
        dnsLookup: dns({ "evil.internal": ["10.0.0.5"] }),
      }),
    ).rejects.toThrow(/private/);
    await expect(
      assertSafeWebhookUrl("https://dualstack.example/x", {
        dnsLookup: dns({ "dualstack.example": ["93.184.216.34", "fd00::1"] }),
      }),
    ).rejects.toThrow(/private/);
  });

  it("rejects literal private IPs and credential-bearing URLs", async () => {
    await expect(assertSafeWebhookUrl("https://127.0.0.1:8080/hook")).rejects.toThrow();
    await expect(assertSafeWebhookUrl("https://user:pass@example.com/hook")).rejects.toThrow(
      /credentials/,
    );
  });

  it("allows dev loopback http only when explicitly enabled", async () => {
    await expect(assertSafeWebhookUrl("http://localhost:9925/hook")).rejects.toThrow(/https/);
    await expect(
      assertSafeWebhookUrl("http://localhost:9925/hook", { allowInsecureLoopback: true }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("rejects unresolvable hosts with a categorized error", async () => {
    await expect(
      assertSafeWebhookUrl("https://no-such-host.invalid/hook", {
        dnsLookup: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toThrow(/resolve/);
  });
});

describe("channel adapters", () => {
  it("telegram validate checks token and chat id shapes", () => {
    const telegram = createTelegramAdapter();
    expect(
      telegram.validate({
        botToken: "123456:AAHfiqksKZ8WmoMTs_fYUtsXq3vN7rBc9",
        chatId: "-100123",
      }),
    ).toBeNull();
    expect(telegram.validate({ botToken: "short", chatId: "-100123" })).not.toBeNull();
    expect(
      telegram.validate({ botToken: "123456:AAHfiqksKZ8WmoMTs_fYUtsXq3vN7rBc9", chatId: "abc!" }),
    ).not.toBeNull();
  });

  it("webhook adapter send returns sanitized failure for private destinations", async () => {
    const webhook = createWebhookAdapter();
    const result = await webhook.sendTest({ url: "http://169.254.169.254/latest/meta-data" });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("ssrf_blocked");
  });

  it("webhook send posts a Slack/Discord-compatible payload without following redirects", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const dnsStub = async (host: string) =>
      host === "hooks.example.com" ? [{ address: "93.184.216.34" }] : [{ address: "10.0.0.1" }];
    const webhook = createWebhookAdapter(
      async (url, init) => {
        calls.push({ url, init });
        return new Response('{"ok":true}', { status: 200 });
      },
      { dnsLookup: dnsStub },
    );
    const result = await webhook.send({ url: "https://hooks.example.com/t" }, "hello", {
      alertType: "watched_live",
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://hooks.example.com/t");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, string>;
    expect(body.text).toBe("hello");
    expect(body.content).toBe("hello");
  });

  it("discord validate rejects a non-Discord URL before ever touching the network", async () => {
    // No fetch/dns stub passed — if the shape check didn't short-circuit
    // first, this would attempt a real DNS lookup and the test would be
    // flaky/network-dependent. It must reject on the regex alone.
    const discord = createDiscordAdapter();
    const result = await discord.validate({ url: "https://hooks.example.com/x" });
    expect(result?.message).toMatch(/not a Discord webhook URL/);
  });

  it("discord adapter send posts a single embed to the webhook URL", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const dnsStub = async () => [{ address: "93.184.216.34" }];
    const discord = createDiscordAdapter(
      async (url, init) => {
        calls.push({ url, init });
        return new Response(null, { status: 204 });
      },
      { dnsLookup: dnsStub },
    );
    const embed = renderAlertEmbed(
      {
        alertType: "restricted_eligible",
        thresholdMinutes: 0,
        projectName: "Robindroids",
        projectSlug: "robindroids5000",
        openseaUrl: null,
        stageLabel: "Allowlist Mint",
        stagePriceDisplay: "0.0042 ETH",
        maxPerWallet: 2,
        walletLabel: "degen main",
        walletAddress: "0xabcdef0123456789abcdef0123456789abcdef01",
        startsAtIso: "2026-08-16T15:00:00.000Z",
        endsAtIso: "2026-08-16T17:00:00.000Z",
      },
      "2026-08-16T14:00:00.000Z",
    );
    const result = await discord.send(
      { url: "https://discord.com/api/webhooks/123456789012345678/abcDEF_-token" },
      embed,
    );
    // Discord's default (wait=false) returns 204 with no body — must count as ok.
    expect(result.ok).toBe(true);
    const body = JSON.parse(String(calls[0]?.init.body)) as { embeds: unknown[] };
    expect(body.embeds).toHaveLength(1);
    expect((body.embeds[0] as { title: string }).title).toContain("WL HIT: Robindroids");
  });

  it("discord sendTest reports ssrf_blocked for a private-resolving host", async () => {
    const discord = createDiscordAdapter(undefined, {
      dnsLookup: async () => [{ address: "10.0.0.5" }],
    });
    const result = await discord.sendTest({
      url: "https://discord.com/api/webhooks/123456789012345678/abcDEF_-token",
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("ssrf_blocked");
  });

  it("surfaces non-2xx as categorized failures with truncated bodies", async () => {
    const telegram = createTelegramAdapter(async () => new Response("nope", { status: 429 }));
    const result = await telegram.send(
      { botToken: "123456:AAHfiqksKZ8WmoMTs_fYUts", chatId: "1" },
      "x",
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("http_429");
    expect(result.sanitizedResponse.length).toBeLessThanOrEqual(300);
  });

  it("web push validate rejects a subscription missing keys, before touching the network", async () => {
    const push = createWebPushAdapter(VAPID);
    const result = await push.validate({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      p256dh: "",
      auth: "",
    });
    expect(result?.message).toMatch(/missing encryption keys/);
  });

  it("web push validate rejects a private-resolving endpoint (SSRF)", async () => {
    const push = createWebPushAdapter(VAPID);
    const result = await push.validate({
      endpoint: "https://169.254.169.254/latest/meta-data",
      p256dh: "p256dh-stub",
      auth: "auth-stub",
    });
    expect(result).not.toBeNull();
  });

  it("web push send delivers via the injected sendImpl and posts the JSON payload", async () => {
    const calls: { subscription: unknown; payload: unknown }[] = [];
    const push = createWebPushAdapter(VAPID, async (subscription, payload) => {
      calls.push({ subscription, payload });
      return { statusCode: 201, body: "", headers: {} };
    });
    const result = await push.send(
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/abc",
        p256dh: "p256dh-stub",
        auth: "auth-stub",
      },
      { title: "WL HIT", body: "Robindroids — Allowlist Mint", url: "https://opensea.io/x" },
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(String(calls[0]?.payload)) as { title: string; url?: string };
    expect(payload.title).toBe("WL HIT");
    expect(payload.url).toBe("https://opensea.io/x");
  });

  it("web push send categorizes a WebPushError (e.g. an expired subscription) by status code", async () => {
    const push = createWebPushAdapter(VAPID, async () => {
      throw new WebPushError(
        "Gone",
        410,
        {},
        "subscription expired",
        "https://fcm.googleapis.com/fcm/send/abc",
      );
    });
    const result = await push.send(
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/abc",
        p256dh: "p256dh-stub",
        auth: "auth-stub",
      },
      { title: "x", body: "y" },
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("http_410");
  });

  it("web push sendTest reports ssrf_blocked for a private-resolving endpoint", async () => {
    const push = createWebPushAdapter(VAPID, async () => {
      throw new Error("sendImpl should never be reached — SSRF guard must reject first");
    });
    const result = await push.sendTest({
      endpoint: "https://169.254.169.254/latest/meta-data",
      p256dh: "p256dh-stub",
      auth: "auth-stub",
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("ssrf_blocked");
  });
});

describe("renderAlertMessage", () => {
  const base = {
    alertType: "restricted_eligible" as const,
    thresholdMinutes: 0,
    projectName: "Robindroids",
    projectSlug: "robindroids5000",
    openseaUrl: null,
    stageLabel: "Allowlist Mint",
    stagePriceDisplay: "0.0042 ETH",
    maxPerWallet: 2,
    walletLabel: "degen main",
    walletAddress: "0xabcdef0123456789abcdef0123456789abcdef01",
    startsAtIso: "2026-08-16T15:00:00.000Z",
    endsAtIso: "2026-08-16T17:00:00.000Z",
  };

  it("renders a WL hit with stage, price, wallet, countdown, and verified link", () => {
    const text = renderAlertMessage(base, "2026-08-16T14:00:00.000Z");
    expect(text).toContain("WL HIT: Robindroids");
    expect(text).toContain("Allowlist Mint");
    expect(text).toContain("0.0042 ETH");
    expect(text).toContain("degen main");
    expect(text).toContain("https://opensea.io/collection/robindroids5000/overview");
    expect(text).toContain("1h 0m from now");
  });

  it("countdown handles past and far-future boundaries", () => {
    expect(formatCountdown("2026-08-16T15:00:00.000Z", "2026-08-19T15:00:00.000Z")).toBe(
      "3d 0h ago",
    );
    expect(formatCountdown(null, "2026-08-16T15:00:00.000Z")).toBeNull();
    expect(formatCountdown("garbage", "2026-08-16T15:00:00.000Z")).toBeNull();
  });

  it("stage_starting includes the threshold window in the headline", () => {
    const text = renderAlertMessage(
      { ...base, alertType: "stage_starting", thresholdMinutes: 15 },
      "2026-08-16T14:45:00.000Z",
    );
    expect(text).toContain("STARTING IN 15m: Robindroids");
  });

  it("renderAlertEmbed builds a structured embed with stage/price/wallet fields and a link", () => {
    const embed = renderAlertEmbed(base, "2026-08-16T14:00:00.000Z");
    expect(embed.title).toContain("WL HIT: Robindroids");
    expect(embed.url).toBe("https://opensea.io/collection/robindroids5000/overview");
    expect(embed.fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(["Stage", "Price", "Max/wallet", "Wallet", "Starts", "Ends"]),
    );
    expect(embed.fields.find((f) => f.name === "Price")?.value).toBe("0.0042 ETH");
    expect(embed.fields.length).toBeLessThanOrEqual(25);
    expect(typeof embed.color).toBe("number");
    expect(embed.footer.text).toBe("HoodMint Radar");
  });

  it("renderAlertEmbed uses a distinct color per alert type", () => {
    const live = renderAlertEmbed(
      { ...base, alertType: "watched_live" },
      "2026-08-16T14:00:00.000Z",
    );
    const eligible = renderAlertEmbed(base, "2026-08-16T14:00:00.000Z");
    expect(live.color).not.toBe(eligible.color);
  });

  it("renderAlertEmbed truncates an overlong field value to Discord's 256-char field-name-adjacent limit", () => {
    const embed = renderAlertEmbed(
      { ...base, walletLabel: "x".repeat(500), walletAddress: "0x1" },
      "2026-08-16T14:00:00.000Z",
    );
    const walletField = embed.fields.find((f) => f.name === "Wallet");
    expect(walletField?.value.length).toBeLessThanOrEqual(256);
    expect(walletField?.value.endsWith("…")).toBe(true);
  });
});

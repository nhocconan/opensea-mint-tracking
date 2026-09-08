import { describe, expect, it } from "vitest";
import { NvtClient } from "./client.ts";
import {
  nvtMeResponseSchema,
  nvtMintSchema,
  nvtMintsResponseSchema,
  nvtWlScanResponseSchema,
} from "./schemas.ts";

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function jsonFetch(body: unknown, log: RecordedCall[] = [], status = 200) {
  return ((url: string, init: RequestInit) => {
    log.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as (url: string, init: RequestInit) => Promise<Response>;
}

const headerOf = (init: RequestInit, name: string) =>
  (init.headers as Record<string, string> | undefined)?.[name];

const SAMPLE_MINT = {
  id: "robinhood:0x1f00abcdef",
  chain: "robinhood",
  contract: "0x1f00abcdef",
  name: "Fortune Foes",
  slug: "fortune-foes",
  links: {
    x: "https://x.com/FortuneFoes",
    site: "https://fortunefoes.com/",
    opensea: "https://opensea.io/collection/fortune-foes",
    mint: "https://fortunefoes.com/",
  },
  stages: [
    {
      kind: "gtd",
      code: "GTD",
      label: "GTD",
      public: false,
      open_to_visitors: true,
      start: "2026-09-07T16:00:00Z",
      end: "2026-09-07T17:00:00Z",
      state: "upcoming",
      price: 0,
      currency: "ETH",
      max_per_wallet: 2,
    },
    {
      kind: "public",
      code: "PUBLIC",
      label: "Public stage",
      public: true,
      open_to_visitors: true,
      start: "2026-09-07T18:00:00Z",
      end: null,
      state: "upcoming",
      price: 0.002,
      currency: "ETH",
      max_per_wallet: 5,
    },
  ],
  active_stage: null,
  next_stage: {
    kind: "gtd",
    label: "GTD",
    public: false,
    open_to_visitors: true,
    start: "2026-09-07T16:00:00Z",
    end: "2026-09-07T17:00:00Z",
    price: 0,
    currency: "ETH",
    max_per_wallet: 2,
  },
  status: "upcoming",
  minted: 0,
  supply: 3333,
  tier: "warm",
  flags: [],
  updated_at: "2026-09-07T10:12:40Z",
};

describe("NVT Schemas", () => {
  it("parses valid mint according to API docs", () => {
    const parsed = nvtMintSchema.safeParse(SAMPLE_MINT);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe("Fortune Foes");
      expect(parsed.data.stages).toHaveLength(2);
      expect(parsed.data.stages[0]?.kind).toBe("gtd");
    }
  });

  it("parses /mints response envelope", () => {
    const envelope = {
      v: 1,
      built: "2026-09-07T10:31:12Z",
      count: 1,
      mints: [SAMPLE_MINT],
    };
    const parsed = nvtMintsResponseSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.count).toBe(1);
      expect(parsed.data.mints[0]?.slug).toBe("fortune-foes");
    }
  });

  it("parses /me response with wallets", () => {
    const me = {
      address: "0x1234567890abcdef1234567890abcdef12345678",
      prefix: "nftt_a1b2",
      usage: 42,
      limit: 120,
      tier: "immortal",
      wallets: [{ a: "0x1234567890abcdef1234567890abcdef12345678", primary: true }],
    };
    const parsed = nvtMeResponseSchema.safeParse(me);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.prefix).toBe("nftt_a1b2");
      expect(parsed.data.wallets).toHaveLength(1);
    }
  });

  it("parses /wl/scan response with listed stages", () => {
    const scan = {
      v: 1,
      address: "0x1234567890abcdef1234567890abcdef12345678",
      checked: 128,
      seconds: 9.4,
      listed: [
        {
          slug: "fortune-foes",
          contract: "0x1f00abcdef",
          stages: [
            {
              label: "GTD",
              kind: "gtd",
              start: "2026-09-07T16:00:00Z",
              end: "2026-09-07T17:00:00Z",
              max_per_wallet: 2,
            },
          ],
        },
      ],
      failed: [],
      skipped: [],
      pass: "os_pass_abc",
      hours: 72,
      quota: { op: "scan", left: 19, per_hour: 20 },
    };
    const parsed = nvtWlScanResponseSchema.safeParse(scan);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.listed).toHaveLength(1);
      expect(parsed.data.listed[0]?.stages[0]?.label).toBe("GTD");
    }
  });
});

describe("NvtClient", () => {
  it("sends X-API-Key in getMe request", async () => {
    const log: RecordedCall[] = [];
    const client = new NvtClient({
      apiKey: "nftt_secretkey",
      fetchImpl: jsonFetch({ address: "0xabc", prefix: "nftt_sec", usage: 10, limit: 120 }, log),
    });

    const res = await client.getMe();
    expect(res.address).toBe("0xabc");
    expect(log).toHaveLength(1);
    expect(headerOf(log[0]?.init ?? {}, "X-API-Key")).toBe("nftt_secretkey");
    expect(log[0]?.url).toBe("https://cdn.neverfuckingtrade.com/api/v1/me");
  });

  it("supports async token provider", async () => {
    const log: RecordedCall[] = [];
    const client = new NvtClient({
      apiKey: async () => "nftt_async_key",
      fetchImpl: jsonFetch(
        { v: 1, built: "2026-09-07T12:00:00Z", count: 1, mints: [SAMPLE_MINT] },
        log,
      ),
    });

    const res = await client.getMints({ chain: "robinhood", status: "live" });
    expect(res.mints).toHaveLength(1);
    expect(headerOf(log[0]?.init ?? {}, "X-API-Key")).toBe("nftt_async_key");
    expect(log[0]?.url).toContain("chain=robinhood");
    expect(log[0]?.url).toContain("status=live");
  });

  it("throws AuthRequired when key is missing", async () => {
    const client = new NvtClient({
      apiKey: "",
      fetchImpl: jsonFetch({}),
    });

    await expect(client.getMe()).rejects.toThrow("NeverFuckingTrade API key is missing");
  });

  it("posts to /wl/scan with address, slugs, and optional pass", async () => {
    const log: RecordedCall[] = [];
    const client = new NvtClient({
      apiKey: "nftt_key",
      fetchImpl: jsonFetch(
        {
          v: 1,
          address: "0x123",
          listed: [
            {
              slug: "fortune-foes",
              stages: [{ label: "GTD", max_per_wallet: 2 }],
            },
          ],
        },
        log,
      ),
    });

    const res = await client.scanWl({
      address: "0x123",
      slugs: ["fortune-foes"],
      openSeaPass: "pass_xyz",
    });

    expect(res.listed).toHaveLength(1);
    expect(log).toHaveLength(1);
    expect(log[0]?.url).toBe("https://neverfuckingtrade.com/api/v1/wl/scan");
    expect(headerOf(log[0]?.init ?? {}, "X-OpenSea-Pass")).toBe("pass_xyz");
    expect(JSON.parse(String(log[0]?.init.body))).toEqual({
      address: "0x123",
      slugs: ["fortune-foes"],
    });
  });
});

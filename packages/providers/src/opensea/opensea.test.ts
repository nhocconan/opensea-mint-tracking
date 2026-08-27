import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "@hoodmint/core";
import { describe, expect, it } from "vitest";
import { fetchJson } from "../http.ts";
import { OpenSeaClient } from "./client.ts";
import { normalizeDropDetail, normalizeDropRow, stageTypeToKind } from "./normalizer.ts";
import { parseDropsPage, parseEligibility } from "./schemas.ts";

const FIXTURES = join(import.meta.dirname, "../../fixtures/opensea");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

interface RoutedCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** Fake fetch routing by URL with per-route status/headers/body. */
function routingFetch(
  routes: {
    match: (url: string) => boolean;
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
  }[],
  log: RoutedCall[] = [],
) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = typeof url === "string" ? url : url.toString();
    log.push({ url: target, init: init ?? {} });
    const route = routes.find((r) => r.match(target));
    if (route === undefined) {
      return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
    }
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: route.headers ?? { "content-type": "application/json" },
    });
  };
}

const wrap = (fn: (url: string, init: RequestInit) => Promise<Response>) =>
  fn as unknown as typeof fetch;

describe("schema parsing", () => {
  it("parses a drops page, dropping malformed rows and counting them", () => {
    const page = parseDropsPage(fixture("drops-upcoming-page1.json"));
    expect(page.rows).toHaveLength(3);
    expect(page.malformed).toBe(1);
    expect(page.next).toBe("cursor-page-2");
  });

  it("parses eligibility with malformed stage rows counted", () => {
    const parsed = parseEligibility(fixture("eligibility-malformed.json"));
    expect(parsed.stages).toHaveLength(1);
    expect(parsed.malformed).toBe(2);
  });

  it("stage type vocabulary maps to domain kinds", () => {
    expect(stageTypeToKind("public_sale")).toBe("public");
    expect(stageTypeToKind("allowlist_sale")).toBe("allowlist");
    expect(stageTypeToKind("PRESALE")).toBe("presale");
    expect(stageTypeToKind("gtd")).toBe("gtd");
    expect(stageTypeToKind("weird-new-type")).toBe("unknown");
  });
});

describe("OpenSeaClient", () => {
  it("resolves the chain identifier from /api/v2/chains, falling back for unlisted chains", async () => {
    const calls: RoutedCall[] = [];
    const client = new OpenSeaClient({
      apiKey: "sk-test",
      fetchImpl: wrap(
        routingFetch(
          [
            {
              match: (u) => u.includes("/api/v2/chains"),
              body: fixture("chains-real-2026-08.json"),
            },
          ],
          calls,
        ),
      ),
    });
    // The real fixture has no robinhood row → fallback slug must survive.
    expect(await client.resolveChainIdentifier("robinhood")).toBe("robinhood");
    expect(calls[0]?.init.headers).toMatchObject({ "x-api-key": "sk-test" });
  });

  it("paginates drops across cursor pages until next is null", async () => {
    const client = new OpenSeaClient({
      fetchImpl: wrap(
        routingFetch([
          {
            match: (u) => u.includes("cursor=cursor-page-2"),
            body: fixture("drops-upcoming-page2.json"),
          },
          { match: (u) => u.includes("/api/v2/drops"), body: fixture("drops-upcoming-page1.json") },
        ]),
      ),
    });
    const result = await client.listDrops("upcoming", "robinhood");
    expect(result.rows).toHaveLength(4);
    expect(result.pages).toBe(2);
    expect(result.malformed).toBe(1);
  });

  it("paginates NFTs across cursor pages until next is null, malformed rows dropped and counted", async () => {
    const page1 = {
      nfts: [
        { identifier: "1", traits: [{ trait_type: "Bg", value: "Red" }] },
        { identifier: "2", traits: [{ trait_type: "Bg", value: "Blue" }] },
        { identifier: "" }, // empty identifier fails min(1) — malformed
      ],
      next: "page-2",
    };
    const page2 = {
      nfts: [{ identifier: "3", traits: [{ trait_type: "Bg", value: "Red" }] }],
      next: null,
    };
    const client = new OpenSeaClient({
      fetchImpl: wrap(
        routingFetch([
          { match: (u) => u.includes("next=page-2"), body: page2 },
          { match: (u) => u.includes("/nfts"), body: page1 },
        ]),
      ),
    });
    const result = await client.listCollectionNfts("some-collection");
    expect(result.rows).toHaveLength(3);
    expect(result.malformed).toBe(1);
    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("marks a listCollectionNfts fetch as truncated when the page cap is hit before the cursor is exhausted", async () => {
    const page1 = { nfts: [{ identifier: "1", traits: [] }], next: "page-2" };
    const client = new OpenSeaClient({
      fetchImpl: wrap(routingFetch([{ match: () => true, body: page1 }])),
    });
    const result = await client.listCollectionNfts("big-collection", { maxPagesOverride: 1 });
    expect(result.pages).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("retries without the chains filter on 400 and filters rows locally (new-chain behavior)", async () => {
    const calls: RoutedCall[] = [];
    const unfiltered = {
      drops: [...(fixture("drops-upcoming-page1.json") as { drops: unknown[] }).drops.slice(0, 3)],
      next: null,
    };
    const client = new OpenSeaClient({
      fetchImpl: wrap(
        routingFetch(
          [
            { match: (u) => !u.includes("chains="), body: unfiltered },
            { match: (u) => u.includes("chains="), status: 400, body: { error: "bad chain" } },
          ],
          calls,
        ),
      ),
    });
    const result = await client.listDrops("upcoming", "robinhood");
    expect(result.chainFilterDropped).toBe(true);
    expect(result.rows.every((r) => r.chain === "robinhood")).toBe(true);
    expect(calls.some((c) => c.url.includes("chains=robinhood"))).toBe(true);
    expect(calls.some((c) => !c.url.includes("chains="))).toBe(true);
  });

  it("honors Retry-After on 429 then succeeds", async () => {
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "slow down" }), {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ drops: [], next: null }), { status: 200 });
    };
    const client = new OpenSeaClient({ fetchImpl: fetchImpl as typeof fetch });
    const result = await client.listDrops("featured", "robinhood");
    expect(result.rows).toHaveLength(0);
    expect(calls).toBe(2);
  }, 10_000);

  it("stops before quota exhaustion using the reserve (PRD §12)", async () => {
    const client = new OpenSeaClient({
      fetchImpl: wrap(
        routingFetch([
          {
            match: (u) => u.includes("/api/v2/drops"),
            body: { drops: [], next: null },
            headers: { "x-ratelimit-remaining": "58", "x-ratelimit-limit": "600" },
          },
        ]),
      ),
    });
    await client.listDrops("featured", "robinhood");
    await expect(client.getDrop("anything")).rejects.toMatchObject({ category: "RateLimited" });
  });

  it("surfaces rate-limit headers after each call", async () => {
    const client = new OpenSeaClient({
      fetchImpl: wrap(
        routingFetch([
          {
            match: () => true,
            body: { drops: [], next: null },
            headers: { "x-ratelimit-remaining": "540", "x-ratelimit-limit": "600" },
          },
        ]),
      ),
    });
    await client.listDrops("featured", "robinhood");
    expect(client.rateLimit()).toEqual({ remaining: 540, limit: 600, resetAtEpochSeconds: null });
  });

  it("categorizes 401 as AuthRequired without leaking headers", async () => {
    const client = new OpenSeaClient({
      fetchImpl: wrap(
        routingFetch([{ match: () => true, status: 401, body: { error: "invalid key" } }]),
      ),
    });
    await expect(client.getDrop("x")).rejects.toMatchObject({ category: "AuthRequired" });
  });

  it("exchanges a PAT for a wallet JWT with expiry", async () => {
    const client = new OpenSeaClient({
      fetchImpl: wrap(
        routingFetch([
          { match: (u) => u.includes("/auth/tokens/exchange"), body: fixture("pat-exchange.json") },
        ]),
      ),
    });
    const exchanged = await client.exchangePat("pat-secret");
    expect(exchanged.jwt.startsWith("jwt-")).toBe(true);
    expect(exchanged.expiresAt.getTime()).toBeGreaterThan(Date.now() + 11 * 3600 * 1000);
  });

  it("creates and rotates free instant keys (headless path)", async () => {
    const client = new OpenSeaClient({
      fetchImpl: wrap(
        routingFetch([
          { match: (u) => u.includes("/auth/keys"), body: fixture("instant-key.json") },
        ]),
      ),
    });
    const key = await client.createInstantKey();
    expect(key.apiKey).toBe("instant_sk_0123456789abcdef");
    expect(key.expiresAt?.toISOString()).toBe("2026-08-23T00:00:00.000Z");
  });

  it("builds a drop mint transaction from OpenSea's own calldata (ADR 0004 amendment)", async () => {
    const log: RoutedCall[] = [];
    const client = new OpenSeaClient({
      apiKey: "sk_test",
      fetchImpl: wrap(
        routingFetch(
          [
            {
              match: (u) => u.includes("/drops/robindroids/mint"),
              body: {
                target: "0x00005ea00ac477b1030ce78506496e8c2de24bf5",
                calldata: "0xabcdef01",
                value: "1000000000000000",
              },
            },
          ],
          log,
        ),
      ),
    });
    const tx = await client.buildDropMintTransaction("robindroids", {
      minter: "0xabcdef0123456789abcdef0123456789abcdef01",
      quantity: 2,
    });
    expect(tx).toEqual({
      target: "0x00005ea00ac477b1030ce78506496e8c2de24bf5",
      calldata: "0xabcdef01",
      valueWei: "1000000000000000",
    });
    expect(log[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(log[0]?.init.body))).toEqual({
      minter: "0xabcdef0123456789abcdef0123456789abcdef01",
      quantity: 2,
    });
    const headers = log[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.["x-api-key"]).toBe("sk_test");
  });

  it("rejects a malformed mint response instead of returning unsafe calldata", async () => {
    const client = new OpenSeaClient({
      fetchImpl: wrap(
        routingFetch([
          { match: (u) => u.includes("/mint"), body: { target: "not-an-address", value: "1" } },
        ]),
      ),
    });
    await expect(
      client.buildDropMintTransaction("robindroids", { minter: "0x0", quantity: 1 }),
    ).rejects.toThrow();
  });
});

describe("normalizer", () => {
  const NOW = new Date("2026-08-16T12:00:00Z");

  it("list rows become projects with stages from active/next stage", () => {
    const page = parseDropsPage(fixture("drops-upcoming-page1.json"));
    const first = page.rows.find((r) => r.collection_slug === "robindroids5000");
    expect(first).toBeDefined();
    const draft = normalizeDropRow(first as never, {
      chainId: 4663,
      now: NOW,
      feedType: "upcoming",
    });
    expect(draft.externalId).toBe("robindroids5000");
    expect(draft.stages[0]?.kind).toBe("allowlist");
    expect(draft.stages[0]?.priceWei).toBe("4200000000000000");
    expect(draft.confidence).toBe("single-source");
    expect(JSON.stringify(draft.evidence?.sanitizedPayload)).not.toContain("i.seadn.io");
  });

  it("detail normalization merges full stage list and marks verified", () => {
    const draft = normalizeDropDetail(fixture("drop-robindroids5000.json"), {
      chainId: 4663,
      now: NOW,
    });
    expect(draft.stages).toHaveLength(2);
    expect(draft.confidence).toBe("verified");
    expect(draft.stages.map((s) => s.kind)).toEqual(["allowlist", "public"]);
  });
});

describe("fetchJson hardening", () => {
  it("rejects oversized bodies", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    await expect(
      fetchJson("https://api.example.test/big", {
        fetchImpl: async () => new Response(big, { status: 200 }),
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ category: "InvalidPayload" });
  });

  it("does not follow redirects", async () => {
    await expect(
      fetchJson("https://api.example.test/redir", {
        fetchImpl: async () =>
          new Response(null, { status: 302, headers: { location: "https://evil.test/" } }),
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("malformed JSON is categorized, not thrown raw", async () => {
    await expect(
      fetchJson("https://api.example.test/bad", {
        fetchImpl: async () => new Response("<html>", { status: 200 }),
      }),
    ).rejects.toMatchObject({ category: "InvalidPayload" });
  });
});

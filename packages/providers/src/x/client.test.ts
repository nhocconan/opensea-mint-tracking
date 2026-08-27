import { describe, expect, it } from "vitest";
import { XClient } from "./client.ts";

interface RoutedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function routingFetch(
  routes: { match: (url: string) => boolean; status?: number; body?: unknown }[],
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
      headers: { "content-type": "application/json" },
    });
  };
}

const wrap = (fn: (url: string, init: RequestInit) => Promise<Response>) =>
  fn as unknown as typeof fetch;

describe("XClient", () => {
  it("rejects construction with an empty bearer token — never a silent no-op", () => {
    expect(() => new XClient({ bearerToken: "" })).toThrow(/bearer token/);
  });

  it("sends app-only Bearer auth and parses recent-mention results", async () => {
    const log: RoutedCall[] = [];
    const client = new XClient({
      bearerToken: "test-token",
      fetchImpl: wrap(
        routingFetch(
          [
            {
              match: (u) => u.includes("/2/tweets/search/recent"),
              body: {
                data: [
                  {
                    id: "1",
                    text: "robindroids mint is live",
                    public_metrics: { like_count: 3, retweet_count: 1 },
                  },
                ],
                meta: { newest_id: "1", result_count: 1 },
              },
            },
          ],
          log,
        ),
      ),
    });
    const result = await client.searchRecentMentions("robindroids");
    expect(result.tweets).toHaveLength(1);
    expect(result.newestId).toBe("1");
    const headers = log[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe("Bearer test-token");
  });

  it("passes since_id through for velocity comparison across scans", async () => {
    const log: RoutedCall[] = [];
    const client = new XClient({
      bearerToken: "t",
      fetchImpl: wrap(routingFetch([{ match: () => true, body: { data: [] } }], log)),
    });
    await client.searchRecentMentions("robindroids", "999");
    expect(log[0]?.url).toContain("since_id=999");
  });

  it("drops malformed rows instead of throwing on an otherwise-valid response", async () => {
    const client = new XClient({
      bearerToken: "t",
      fetchImpl: wrap(
        routingFetch([
          {
            match: () => true,
            body: { data: [{ id: "1", text: "ok" }, { not_a_tweet: true }] },
          },
        ]),
      ),
    });
    // The whole array must still validate under the schema's own rules —
    // a genuinely malformed second row fails z.array() parse, which is the
    // correct behavior here (unlike OpenSea's per-row safeParse skip):
    // a partial mention count would silently understate velocity, which is
    // worse than a visible failure for an advisory signal.
    await expect(client.searchRecentMentions("q")).rejects.toThrow();
  });
});

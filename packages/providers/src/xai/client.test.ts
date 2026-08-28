import { describe, expect, it } from "vitest";
import { XaiClient } from "./client.ts";
import {
  extractOutputText,
  normalizeGrokSignal,
  parseGrokSignal,
  xaiResponsesEnvelopeSchema,
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

/** A well-formed answer, as the Responses API returns it. */
function responsesEnvelope(text: string, citations: string[] = []) {
  return {
    id: "resp_1",
    output: [
      { type: "reasoning", summary: [] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    citations,
  };
}

const VALID_SIGNAL = {
  hype_score: 72,
  risk_score: 15,
  phishing_flags: ["lookalike handle"],
  summary: "Steady chatter from the official account.",
  notable_posts: [{ url: "https://x.com/a/1", handle: "@a", why: "announcement" }],
  sources: ["https://x.com/a/1"],
};

describe("parseGrokSignal", () => {
  it("parses a strict-schema answer", () => {
    const parsed = parseGrokSignal(JSON.stringify(VALID_SIGNAL));
    expect(parsed).not.toBeNull();
    expect(parsed?.hype_score).toBe(72);
    expect(parsed?.risk_score).toBe(15);
    expect(parsed?.notable_posts).toHaveLength(1);
  });

  it("tolerates a ```json fence the model added anyway", () => {
    const parsed = parseGrokSignal(`\`\`\`json\n${JSON.stringify(VALID_SIGNAL)}\n\`\`\``);
    expect(parsed?.hype_score).toBe(72);
  });

  it("fills optional fields so a partial answer is still usable", () => {
    const parsed = parseGrokSignal(JSON.stringify({ hype_score: 10, risk_score: 90 }));
    expect(parsed).toEqual({
      hype_score: 10,
      risk_score: 90,
      phishing_flags: [],
      summary: "",
      notable_posts: [],
      sources: [],
    });
  });

  it("returns null (never throws) for malformed model output", () => {
    expect(parseGrokSignal("")).toBeNull();
    expect(parseGrokSignal("I'm sorry, I can't help with that.")).toBeNull();
    expect(parseGrokSignal("{ not json ")).toBeNull();
    // Right JSON, wrong contract: scores must be numbers.
    expect(parseGrokSignal(JSON.stringify({ hype_score: "high", risk_score: 1 }))).toBeNull();
    expect(parseGrokSignal(JSON.stringify({ summary: "no scores" }))).toBeNull();
  });

  it("clamps and rounds out-of-range scores before they reach the database", () => {
    const parsed = parseGrokSignal(JSON.stringify({ hype_score: 480, risk_score: -20 }));
    expect(parsed?.hype_score).toBe(100);
    expect(parsed?.risk_score).toBe(0);
    expect(parseGrokSignal(JSON.stringify({ hype_score: 71.6, risk_score: 0 }))?.hype_score).toBe(
      72,
    );
  });

  it("bounds array and string sizes so evidence jsonb cannot be flooded", () => {
    const normalized = normalizeGrokSignal({
      hype_score: 1,
      risk_score: 1,
      phishing_flags: Array.from({ length: 50 }, () => "x".repeat(500)),
      summary: "y".repeat(5000),
      notable_posts: Array.from({ length: 30 }, () => ({ url: "u", handle: "h", why: "w" })),
      sources: Array.from({ length: 100 }, () => "s"),
    });
    expect(normalized.phishing_flags).toHaveLength(12);
    expect(normalized.phishing_flags[0]).toHaveLength(120);
    expect(normalized.summary).toHaveLength(600);
    expect(normalized.notable_posts).toHaveLength(5);
    expect(normalized.sources).toHaveLength(20);
  });

  it("treats any non-finite score as 0 — garbage is 'no signal', never a NaN row", () => {
    expect(
      normalizeGrokSignal({
        hype_score: Number.NaN,
        risk_score: Number.POSITIVE_INFINITY,
        phishing_flags: [],
        summary: "",
        notable_posts: [],
        sources: [],
      }),
    ).toMatchObject({ hype_score: 0, risk_score: 0 });
  });
});

describe("extractOutputText", () => {
  it("reads the assistant text out of output[].content[]", () => {
    const envelope = xaiResponsesEnvelopeSchema.parse(responsesEnvelope("hello"));
    expect(extractOutputText(envelope)).toBe("hello");
  });

  it("ignores unknown output item types instead of failing the scan", () => {
    const envelope = xaiResponsesEnvelopeSchema.parse({
      output: [
        { type: "x_search_call", status: "completed" },
        { type: "message", content: [{ type: "output_text", text: "{}" }] },
      ],
    });
    expect(extractOutputText(envelope)).toBe("{}");
  });

  it("falls back to the top-level output_text convenience field", () => {
    const envelope = xaiResponsesEnvelopeSchema.parse({ output: [], output_text: "fallback" });
    expect(extractOutputText(envelope)).toBe("fallback");
  });
});

describe("XaiClient.scanSentiment", () => {
  const tokenProvider = () => Promise.resolve("test-token");

  it("posts /responses with the x_search tool and a strict json_schema", async () => {
    const log: RecordedCall[] = [];
    const client = new XaiClient({
      model: "grok-4",
      tokenProvider,
      fetchImpl: jsonFetch(responsesEnvelope(JSON.stringify(VALID_SIGNAL)), log),
    });
    const result = await client.scanSentiment({ name: "Robindroids", slug: "robindroids" });

    const call = log[0];
    expect(call?.url).toBe("https://api.x.ai/v1/responses");
    expect(call?.init.method).toBe("POST");
    // The bearer is sent, and only in the header.
    expect(headerOf(call?.init ?? {}, "authorization")).toBe("Bearer test-token");

    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("grok-4");
    expect(body.tools).toEqual([{ type: "x_search", max_search_results: 20 }]);
    expect(body.temperature).toBe(0);
    expect(body.store).toBe(false);
    const format = (body.text as { format: Record<string, unknown> }).format;
    expect(format.type).toBe("json_schema");
    expect(format.strict).toBe(true);
    // The subject reaches the prompt so Grok knows what to search for.
    expect(JSON.stringify(body.input)).toContain("Robindroids");
    expect(JSON.stringify(body.input)).toContain("robindroids");

    expect(result.signal?.hype_score).toBe(72);
    expect(result.model).toBe("grok-4");
  });

  it("passes the contract address through when the project has one", async () => {
    const log: RecordedCall[] = [];
    const client = new XaiClient({
      model: "grok-4",
      tokenProvider,
      fetchImpl: jsonFetch(responsesEnvelope("{}"), log),
    });
    await client.scanSentiment({ name: "N", slug: null, contractAddress: "0xabc" });
    expect(JSON.stringify(JSON.parse(String(log[0]?.init.body)).input)).toContain("0xabc");
  });

  it("returns citations for provenance", async () => {
    const client = new XaiClient({
      model: "grok-4",
      tokenProvider,
      fetchImpl: jsonFetch(
        responsesEnvelope(JSON.stringify(VALID_SIGNAL), ["https://x.com/a/1", "https://x.com/b/2"]),
      ),
    });
    const result = await client.scanSentiment({ name: "N" });
    expect(result.citations).toEqual(["https://x.com/a/1", "https://x.com/b/2"]);
  });

  it("yields signal:null for an unparseable answer instead of throwing", async () => {
    const client = new XaiClient({
      model: "grok-4",
      tokenProvider,
      fetchImpl: jsonFetch(responsesEnvelope("I could not find anything.")),
    });
    const result = await client.scanSentiment({ name: "N" });
    expect(result.signal).toBeNull();
    expect(result.model).toBe("grok-4");
  });

  it("refuses an empty token rather than sending an anonymous request", async () => {
    const client = new XaiClient({
      model: "grok-4",
      tokenProvider: () => Promise.resolve("  "),
      fetchImpl: jsonFetch(responsesEnvelope("{}")),
    });
    await expect(client.scanSentiment({ name: "N" })).rejects.toMatchObject({
      category: "AuthRequired",
    });
  });

  it("rejects construction without a model id", () => {
    expect(() => new XaiClient({ model: " ", tokenProvider })).toThrow(/model/);
  });

  it("honours a custom API base for a private deployment", async () => {
    const log: RecordedCall[] = [];
    const client = new XaiClient({
      model: "grok-4",
      tokenProvider,
      baseUrl: "https://api.example.com/v1/",
      fetchImpl: jsonFetch(responsesEnvelope("{}"), log),
    });
    await client.scanSentiment({ name: "N" });
    expect(log[0]?.url).toBe("https://api.example.com/v1/responses");
  });
});

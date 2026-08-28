/**
 * Zod boundary for xAI Responses API payloads (ADR 0007). External data —
 * including anything Grok wrote, which is itself derived from attacker-
 * controllable X posts — starts as `unknown` and is parsed exactly once,
 * same discipline as packages/providers/src/opensea/schemas.ts.
 */
import { z } from "zod";

/**
 * POST /v1/responses envelope. Verified 2026-08-28 against
 * docs.x.ai/developers/tools/citations and .../text/structured-outputs:
 * the assistant text lives in `output[].content[]` items of type
 * `output_text`, and every URL the agent actually cited is listed in the
 * top-level `citations` array.
 *
 * Deliberately permissive about the parts we don't consume: xAI adds output
 * item types (reasoning, tool calls) over time, and an unknown item type
 * must not fail the whole scan.
 */
export const xaiResponsesEnvelopeSchema = z.object({
  output: z
    .array(
      z.object({
        type: z.string().optional(),
        content: z
          .array(
            z.object({
              type: z.string().optional(),
              text: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .default([]),
  /** Convenience aggregate when the server supplies it. */
  output_text: z.string().optional(),
  citations: z.array(z.string()).default([]),
});

export type XaiResponsesEnvelope = z.infer<typeof xaiResponsesEnvelopeSchema>;

/** Concatenate the assistant's `output_text` blocks, in order. */
export function extractOutputText(envelope: XaiResponsesEnvelope): string {
  const fromItems = envelope.output
    .flatMap((item) => item.content ?? [])
    .filter((block) => block.type === undefined || block.type === "output_text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
  if (fromItems !== "") {
    return fromItems;
  }
  return (envelope.output_text ?? "").trim();
}

/**
 * The strict JSON contract we ask Grok for. Everything has a default except
 * the two scores, so a partially-filled answer still yields a usable signal
 * rather than being discarded.
 */
export const grokSignalSchema = z.object({
  hype_score: z.number(),
  risk_score: z.number(),
  phishing_flags: z.array(z.string()).default([]),
  summary: z.string().default(""),
  notable_posts: z
    .array(
      z.object({
        url: z.string().default(""),
        handle: z.string().default(""),
        why: z.string().default(""),
      }),
    )
    .default([]),
  sources: z.array(z.string()).default([]),
});

export type GrokSignal = z.infer<typeof grokSignalSchema>;

/** JSON Schema handed to the Responses API's `text.format` structured output. */
export const GROK_SIGNAL_JSON_SCHEMA = {
  type: "object",
  properties: {
    hype_score: { type: "number", description: "0-100 how loud/positive the chatter is" },
    risk_score: { type: "number", description: "0-100 likelihood of scam/phishing/impersonation" },
    phishing_flags: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    notable_posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string" },
          handle: { type: "string" },
          why: { type: "string" },
        },
        required: ["url", "handle", "why"],
      },
    },
    sources: { type: "array", items: { type: "string" } },
  },
  required: ["hype_score", "risk_score", "phishing_flags", "summary", "notable_posts", "sources"],
} as const;

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Bound every field a model produced before it reaches the database. */
export function normalizeGrokSignal(signal: GrokSignal): GrokSignal {
  return {
    hype_score: clampScore(signal.hype_score),
    risk_score: clampScore(signal.risk_score),
    // Bounded so a runaway generation cannot bloat the evidence jsonb.
    phishing_flags: signal.phishing_flags.slice(0, 12).map((f) => f.slice(0, 120)),
    summary: signal.summary.slice(0, 600),
    notable_posts: signal.notable_posts.slice(0, 5).map((p) => ({
      url: p.url.slice(0, 300),
      handle: p.handle.slice(0, 80),
      why: p.why.slice(0, 200),
    })),
    sources: signal.sources.slice(0, 20).map((s) => s.slice(0, 300)),
  };
}

/**
 * Parse a model-authored JSON string. Tolerates a ```json fence, which
 * models still emit occasionally even under a strict schema. Returns null
 * instead of throwing — the caller records a low-confidence empty signal.
 */
export function parseGrokSignal(text: string): GrokSignal | null {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (unfenced === "") {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(unfenced);
  } catch {
    return null;
  }
  const parsed = grokSignalSchema.safeParse(raw);
  return parsed.success ? normalizeGrokSignal(parsed.data) : null;
}

/**
 * Zod boundary for X API v2 responses (ADR 0007). External data starts as
 * `unknown` and is parsed exactly once, same discipline as
 * packages/providers/src/opensea/schemas.ts.
 */
import { z } from "zod";

export const tweetSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  author_id: z.string().optional(),
  created_at: z.string().optional(),
  public_metrics: z
    .object({
      retweet_count: z.number().int().nonnegative().optional(),
      reply_count: z.number().int().nonnegative().optional(),
      like_count: z.number().int().nonnegative().optional(),
      quote_count: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export const searchRecentResponseSchema = z.object({
  data: z.array(tweetSchema).default([]),
  meta: z
    .object({
      result_count: z.number().int().nonnegative().optional(),
      newest_id: z.string().optional(),
      oldest_id: z.string().optional(),
      next_token: z.string().optional(),
    })
    .optional(),
});

export type ParsedTweet = z.infer<typeof tweetSchema>;

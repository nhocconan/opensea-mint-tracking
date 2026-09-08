/**
 * Zod validation boundary for NeverFuckingTrade (NFT Trencher) API.
 * External payloads are treated as unknown until validation succeeds (PRD §14).
 *
 * References: https://cdn.neverfuckingtrade.com/api/
 */
import { z } from "zod";

export const nvtStageSchema = z.object({
  kind: z.string().default("other"),
  code: z.string().optional(),
  label: z.string().default("Stage"),
  public: z.boolean().default(false),
  open_to_visitors: z.boolean().default(true),
  start: z.string(),
  end: z.string().nullable().optional(),
  state: z.string().optional(),
  price: z.union([z.number(), z.string()]).nullable().optional(),
  currency: z.string().default("ETH"),
  max_per_wallet: z.number().nullable().optional(),
});

export type NvtStage = z.infer<typeof nvtStageSchema>;

export const nvtMintLinksSchema = z
  .object({
    x: z.string().nullable().optional(),
    site: z.string().nullable().optional(),
    opensea: z.string().nullable().optional(),
    mint: z.string().nullable().optional(),
  })
  .optional()
  .default({});

export type NvtMintLinks = z.infer<typeof nvtMintLinksSchema>;

export const nvtMintSchema = z.object({
  id: z.string(),
  chain: z.string().default("robinhood"),
  contract: z.string(),
  name: z.string(),
  slug: z.string().optional().default(""),
  links: nvtMintLinksSchema,
  stages: z.array(nvtStageSchema).default([]),
  active_stage: nvtStageSchema.nullable().optional(),
  next_stage: nvtStageSchema.nullable().optional(),
  status: z.string().default("upcoming"),
  minted: z.union([z.number(), z.string()]).optional().default(0),
  supply: z.union([z.number(), z.string()]).nullable().optional(),
  tier: z.string().default("warm"),
  flags: z.array(z.string()).default([]),
  updated_at: z.string().optional(),
});

export type NvtMint = z.infer<typeof nvtMintSchema>;

export const nvtMintsResponseSchema = z.object({
  v: z.number().optional(),
  built: z.string().optional(),
  count: z.number().optional(),
  mints: z.array(nvtMintSchema),
});

export type NvtMintsResponse = z.infer<typeof nvtMintsResponseSchema>;

export const nvtWalletEntrySchema = z.union([
  z.string(),
  z.object({
    a: z.string(),
    primary: z.boolean().optional(),
  }),
]);

export const nvtMeResponseSchema = z.object({
  profile: z.string().optional(),
  address: z.string().optional(),
  prefix: z.string().optional(),
  usage: z.number().optional(),
  limit: z.number().optional(),
  tier: z.string().optional(),
  wallets: z.array(nvtWalletEntrySchema).optional().default([]),
  error: z.string().optional(),
  hint: z.string().optional(),
});

export type NvtMeResponse = z.infer<typeof nvtMeResponseSchema>;

export const nvtListedStageSchema = z.object({
  label: z.string(),
  kind: z.string().optional(),
  start: z.string().optional(),
  end: z.string().nullable().optional(),
  max_per_wallet: z.number().nullable().optional(),
});

export type NvtListedStage = z.infer<typeof nvtListedStageSchema>;

export const nvtListedItemSchema = z.object({
  slug: z.string().optional(),
  contract: z.string().optional(),
  stages: z.array(nvtListedStageSchema).default([]),
});

export type NvtListedItem = z.infer<typeof nvtListedItemSchema>;

export const nvtWlScanResponseSchema = z.object({
  v: z.number().optional(),
  address: z.string(),
  checked: z.number().optional(),
  seconds: z.number().optional(),
  listed: z.array(nvtListedItemSchema).default([]),
  failed: z.array(z.string()).optional().default([]),
  skipped: z.array(z.string()).optional().default([]),
  pass: z.string().optional(),
  hours: z.number().optional(),
  quota: z
    .object({
      op: z.string().optional(),
      left: z.number().optional(),
      per_hour: z.number().optional(),
    })
    .optional(),
});

export type NvtWlScanResponse = z.infer<typeof nvtWlScanResponseSchema>;

export const nvtWlNonceResponseSchema = z.object({
  message: z.string(),
});

export type NvtWlNonceResponse = z.infer<typeof nvtWlNonceResponseSchema>;

export const nvtWlPassResponseSchema = z.object({
  pass: z.string(),
  hours: z.number().optional().default(72),
});

export type NvtWlPassResponse = z.infer<typeof nvtWlPassResponseSchema>;

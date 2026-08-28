/**
 * Zod boundary for OpenSea JSON (PRD §14): external data starts as `unknown`
 * and is parsed exactly once. Malformed rows are dropped and counted, never
 * crashing a discovery cycle (PRD §18 resilience requirement).
 */
import { z } from "zod";

export const chainInfoSchema = z.object({
  chain: z.string().min(1),
  name: z.string().min(1),
  symbol: z.string().optional(),
  block_explorer_url: z.string().optional(),
});

export const chainsResponseSchema = z.object({ chains: z.array(chainInfoSchema) });

const weiString = z
  .string()
  .regex(/^[0-9]+$/, "wei must be a decimal string")
  .transform((v) => v);

const positiveIntString = z
  .string()
  .regex(/^[0-9]+$/)
  .transform((v) => {
    const parsed = Number.parseInt(v, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  });

const isoTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "invalid ISO time");

export const stageSchema = z.object({
  uuid: z.string().min(1),
  stage_type: z.string().min(1),
  start_time: isoTime,
  end_time: isoTime.nullable().optional(),
  label: z.string().optional(),
  price: weiString.nullable().optional(),
  price_currency_address: z.string().nullable().optional(),
  max_per_wallet: positiveIntString.nullable().optional(),
  paused: z.boolean().optional(),
});

export const dropRowSchema = z.object({
  chain: z.string().min(1),
  collection_slug: z.string().min(1),
  contract_address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .nullable()
    .optional(),
  collection_name: z.string().optional(),
  image_url: z.string().nullable().optional(),
  opensea_url: z.string().nullable().optional(),
  is_minting: z.boolean().optional(),
  drop_type: z.string().optional(),
  active_stage: stageSchema.nullable().optional(),
  next_stage: stageSchema.nullable().optional(),
  /** Detail endpoint shape: full stage list. */
  stages: z.array(stageSchema).optional(),
});

export const dropsResponseSchema = z.object({
  drops: z.array(z.unknown()).default([]),
  next: z.string().nullable().optional(),
});

/**
 * Chain membership test shared by the drops filter and the chain-wide
 * collections sweep. Lives here (not in client.ts) so the parse layer can
 * filter rows to the target chain without a client→schemas→client import
 * cycle. Robinhood Chain is emitted as its slug or its numeric id (4663)
 * depending on the endpoint, so both are treated as a match.
 */
export function matchesChain(rowChain: string, targetSlug: string): boolean {
  const normalized = rowChain.toLowerCase();
  const target = targetSlug.toLowerCase();
  return (
    normalized === target ||
    normalized === "4663" ||
    normalized.replace(/[-_]/g, "") === target.replace(/[-_]/g, "") ||
    normalized.includes(target)
  );
}

/**
 * Chain-wide collections listing: `GET /api/v2/collections?chain=<slug>
 * &order_by=created_date&order_direction=desc&limit=<n>[&next=<cursor>]`.
 * The curated `/drops` feed only surfaces OpenSea-featured SeaDrop drops, so
 * most real Robinhood Chain collections never appear there — this endpoint is
 * the authoritative "everything on the chain, newest first" source. A
 * collection carries no stage schedule; a later `/drops/{slug}` detail fetch
 * fills stages in for the ones that ARE drops.
 */
const collectionContractSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chain: z.string().min(1),
});

export const collectionRowSchema = z.object({
  collection: z.string().min(1),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
  contracts: z.array(collectionContractSchema).default([]),
  // Kept lenient (not isoTime): a malformed/absent created_date must not drop
  // an otherwise valid on-chain collection from discovery.
  created_date: z.string().nullable().optional(),
});

export const collectionsResponseSchema = z.object({
  collections: z.array(z.unknown()).default([]),
  next: z.string().nullable().optional(),
});

export interface ParsedCollectionRow {
  readonly slug: string;
  readonly name: string;
  readonly imageUrl: string | null;
  /** The contract on the TARGET chain (a collection may span several). */
  readonly contractAddress: string;
  readonly createdDate: string | null;
}

export interface ParsedCollectionsPage {
  readonly rows: ParsedCollectionRow[];
  readonly malformed: number;
  readonly next: string | null;
}

/**
 * Parse one collections page and keep only rows with a contract on
 * `chainSlug`. Schema-invalid rows are counted as `malformed`; valid rows
 * that simply live on another chain are silently filtered out (not
 * malformed).
 */
export function parseCollectionsPage(payload: unknown, chainSlug: string): ParsedCollectionsPage {
  const page = collectionsResponseSchema.parse(payload);
  const rows: ParsedCollectionRow[] = [];
  let malformed = 0;
  for (const raw of page.collections) {
    const result = collectionRowSchema.safeParse(raw);
    if (!result.success) {
      malformed += 1;
      continue;
    }
    const onChain = result.data.contracts.find((c) => matchesChain(c.chain, chainSlug));
    if (onChain === undefined) {
      continue;
    }
    rows.push({
      slug: result.data.collection,
      name: result.data.name ?? result.data.collection,
      imageUrl: result.data.image_url ?? null,
      contractAddress: onChain.address,
      createdDate: result.data.created_date ?? null,
    });
  }
  return { rows, malformed, next: page.next ?? null };
}

export const eligibilityStageSchema = z.object({
  stage_uuid: z.string().min(1),
  is_eligible: z.boolean(),
  max_total_mintable_by_wallet: positiveIntString.nullable().optional(),
  max_total_mintable_by_wallet_per_token: positiveIntString.nullable().optional(),
  price: weiString.nullable().optional(),
});

export const eligibilityResponseSchema = z.object({
  stages: z.array(z.unknown()).default([]),
});

const secondsNumber = z
  .union([z.string().regex(/^[0-9]+$/), z.number().int().nonnegative()])
  .transform((v) => (typeof v === "string" ? Number.parseInt(v, 10) : v));

export const exchangeResponseSchema = z.object({
  accessToken: z.string().min(1).optional(),
  access_token: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
  expiresIn: secondsNumber.nullable().optional(),
  expires_in: secondsNumber.nullable().optional(),
});

export const instantKeyResponseSchema = z.object({
  api_key: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  expires_at: isoTime.nullable().optional(),
  expiresAt: isoTime.nullable().optional(),
});

/**
 * `POST /api/v2/drops/{slug}/mint` (docs.opensea.io/docs/mint-from-a-drop,
 * verified 2026-08-21; see ADR 0004 amendment). Returns ready-to-broadcast
 * calldata OpenSea itself computed — the caller never hand-rolls SeaDrop
 * calldata for OpenSea-hosted drops. `minter` in the request is the
 * *recipient*, independent of whoever signs/broadcasts, which is exactly
 * the shape a Zodiac-Roles-scoped session key needs (ADR 0004).
 */
export const dropMintResponseSchema = z.object({
  target: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "target must be an address"),
  calldata: z.string().regex(/^0x[0-9a-fA-F]*$/, "calldata must be hex"),
  value: weiString,
});

export interface ParsedDropsPage {
  readonly rows: z.infer<typeof dropRowSchema>[];
  readonly malformed: number;
  readonly next: string | null;
}

export function parseDropsPage(payload: unknown): ParsedDropsPage {
  const page = dropsResponseSchema.parse(payload);
  const rows: z.infer<typeof dropRowSchema>[] = [];
  let malformed = 0;
  for (const raw of page.drops) {
    const result = dropRowSchema.safeParse(raw);
    if (result.success) {
      rows.push(result.data);
    } else {
      malformed += 1;
    }
  }
  return { rows, malformed, next: page.next ?? null };
}

// Trait rarity ranking (feature-backlog.md §2, shipped 2026-08-22).
// GET /api/v2/collection/{slug}/nfts — verified live against current
// OpenSea docs 2026-08-22, not assumed from memory.
export const nftTraitSchema = z.object({
  trait_type: z.string().min(1),
  value: z.union([z.string(), z.number()]),
  display_type: z.string().nullable().optional(),
  max_value: z.union([z.string(), z.number()]).nullable().optional(),
});

export const nftRowSchema = z.object({
  identifier: z.string().min(1),
  name: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
  display_image_url: z.string().nullable().optional(),
  traits: z.array(nftTraitSchema).default([]),
});

export const nftsResponseSchema = z.object({
  nfts: z.array(z.unknown()).default([]),
  next: z.string().nullable().optional(),
});

export interface ParsedNftsPage {
  readonly rows: z.infer<typeof nftRowSchema>[];
  readonly malformed: number;
  readonly next: string | null;
}

export function parseNftsPage(payload: unknown): ParsedNftsPage {
  const page = nftsResponseSchema.parse(payload);
  const rows: z.infer<typeof nftRowSchema>[] = [];
  let malformed = 0;
  for (const raw of page.nfts) {
    const result = nftRowSchema.safeParse(raw);
    if (result.success) {
      rows.push(result.data);
    } else {
      malformed += 1;
    }
  }
  return { rows, malformed, next: page.next ?? null };
}

export interface ParsedEligibility {
  readonly stages: z.infer<typeof eligibilityStageSchema>[];
  readonly malformed: number;
}

export function parseEligibility(payload: unknown): ParsedEligibility {
  const page = eligibilityResponseSchema.parse(payload);
  const stages: z.infer<typeof eligibilityStageSchema>[] = [];
  let malformed = 0;
  for (const raw of page.stages) {
    const result = eligibilityStageSchema.safeParse(raw);
    if (result.success) {
      stages.push(result.data);
    } else {
      malformed += 1;
    }
  }
  return { stages, malformed };
}

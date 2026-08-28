/**
 * Normalization (PRD §7.2): provider DTOs → domain-neutral drafts. Business
 * decisions (identity merge, conflict policy) live in the db repository; this
 * module only maps and validates shapes, preserving provenance hooks.
 */
import { createHash } from "node:crypto";
import type { Confidence, StageKind } from "@hoodmint/core";
import type { ProjectUpsert, StageUpsert } from "@hoodmint/db";
import type { z } from "zod";
import {
  dropRowSchema,
  type ParsedCollectionRow,
  type ParsedEligibility,
  type stageSchema,
} from "./schemas.ts";

const STAGE_KIND_MAP: Readonly<Record<string, StageKind>> = {
  public_sale: "public",
  public: "public",
  open: "public",
  allowlist: "allowlist",
  allowlist_sale: "allowlist",
  allow_list: "allowlist",
  presale: "presale",
  pre_sale: "presale",
  gtd: "gtd",
  guaranteed: "gtd",
  community: "community",
  community_sale: "community",
};

export function stageTypeToKind(stageType: string): StageKind {
  return STAGE_KIND_MAP[stageType.toLowerCase()] ?? "unknown";
}

function toStageUpsert(stage: z.infer<typeof stageSchema>): StageUpsert {
  return {
    providerStageId: stage.uuid,
    label: stage.label ?? stage.stage_type,
    kind: stageTypeToKind(stage.stage_type),
    priceWei: stage.price ?? null,
    currency: stage.price_currency_address ?? null,
    maxPerWallet: stage.max_per_wallet ?? null,
    startsAt: new Date(stage.start_time),
    endsAt:
      stage.end_time !== undefined && stage.end_time !== null ? new Date(stage.end_time) : null,
    paused: stage.paused ?? false,
  };
}

export function contentHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

export interface NormalizeOptions {
  readonly chainId: number;
  readonly now: Date;
  readonly feedType?: string;
}

/** List-row normalization: stages from active_stage + next_stage. */
export function normalizeDropRow(
  row: z.infer<typeof dropRowSchema>,
  options: NormalizeOptions,
): ProjectUpsert {
  const stages: StageUpsert[] = [];
  if (row.active_stage !== undefined && row.active_stage !== null) {
    stages.push(toStageUpsert(row.active_stage));
  }
  if (row.next_stage !== undefined && row.next_stage !== null) {
    stages.push(toStageUpsert(row.next_stage));
  }
  return {
    providerKind: "opensea",
    externalId: row.collection_slug,
    chainId: options.chainId,
    contractAddress: row.contract_address ?? null,
    name: row.collection_name ?? row.collection_slug,
    slug: row.collection_slug,
    imageUrl: row.image_url ?? null,
    confidence: "single-source" satisfies Confidence,
    stages,
    supply: null,
    evidence: {
      kind: `drops:${options.feedType ?? "list"}`,
      fetchedAt: options.now,
      contentHash: contentHash(row),
      sanitizedPayload: {
        chain: row.chain,
        slug: row.collection_slug,
        contract: row.contract_address ?? null,
        is_minting: row.is_minting ?? null,
        drop_type: row.drop_type ?? null,
        stages: stages.map((s) => s.providerStageId),
      },
    },
    now: options.now,
  };
}

/**
 * Chain-wide collection normalization (PRD §7.2): maps one collections-feed
 * row to the same `ProjectUpsert` shape `upsertProjectFromSource` consumes.
 * A collection carries NO stage schedule, so it yields a project with no
 * stages (lifecycle resolves to UNKNOWN in core) and "single-source"
 * confidence — a later `/drops/{slug}` detail refresh upgrades the ones that
 * are actually SeaDrop drops to a full, verified stage list.
 */
export function normalizeCollectionRow(
  row: ParsedCollectionRow,
  options: NormalizeOptions,
): ProjectUpsert {
  return {
    providerKind: "opensea",
    externalId: row.slug,
    chainId: options.chainId,
    contractAddress: row.contractAddress,
    name: row.name,
    slug: row.slug,
    imageUrl: row.imageUrl,
    confidence: "single-source" satisfies Confidence,
    stages: [],
    supply: null,
    evidence: {
      kind: "collections:list",
      fetchedAt: options.now,
      contentHash: contentHash(row),
      sanitizedPayload: {
        slug: row.slug,
        contract: row.contractAddress,
        createdDate: row.createdDate,
      },
    },
    now: options.now,
  };
}

/** Detail normalization: full stage list when provided. */
export function normalizeDropDetail(payload: unknown, options: NormalizeOptions): ProjectUpsert {
  const row = dropRowSchema.parse(payload);
  const stages = (row.stages ?? []).map(toStageUpsert);
  const active =
    row.active_stage !== undefined && row.active_stage !== null
      ? toStageUpsert(row.active_stage)
      : null;
  const next =
    row.next_stage !== undefined && row.next_stage !== null ? toStageUpsert(row.next_stage) : null;
  const merged = [...stages];
  for (const extra of [active, next]) {
    if (extra !== null && !merged.some((s) => s.providerStageId === extra.providerStageId)) {
      merged.push(extra);
    }
  }
  return {
    providerKind: "opensea",
    externalId: row.collection_slug,
    chainId: options.chainId,
    contractAddress: row.contract_address ?? null,
    name: row.collection_name ?? row.collection_slug,
    slug: row.collection_slug,
    imageUrl: row.image_url ?? null,
    // Detail fetch is the authoritative OpenSea view of its own schedule.
    confidence: "verified" satisfies Confidence,
    stages: merged,
    supply: null,
    evidence: {
      kind: "drops:detail",
      fetchedAt: options.now,
      contentHash: contentHash(row),
      sanitizedPayload: {
        chain: row.chain,
        slug: row.collection_slug,
        contract: row.contract_address ?? null,
        is_minting: row.is_minting ?? null,
        stageCount: merged.length,
      },
    },
    now: options.now,
  };
}

export interface EligibilityStageResult {
  readonly stageUuid: string;
  readonly eligible: boolean | null;
  readonly maxMintable: number | null;
  readonly priceWei: string | null;
}

/**
 * Map authenticated eligibility stages. Public stages are marked kind public
 * here when the stage type is known from the stage map — classification of
 * restricted-vs-public then happens in core, which can only see the kind.
 */
export function normalizeEligibility(
  parsed: ParsedEligibility,
  stagesByUuid: ReadonlyMap<string, StageUpsert>,
): { results: EligibilityStageResult[]; unknownStages: number } {
  const results: EligibilityStageResult[] = [];
  let unknownStages = 0;
  for (const stage of parsed.stages) {
    const known = stagesByUuid.get(stage.stage_uuid);
    if (known === undefined) {
      unknownStages += 1;
    }
    results.push({
      stageUuid: stage.stage_uuid,
      eligible: stage.is_eligible,
      maxMintable:
        stage.max_total_mintable_by_wallet ?? stage.max_total_mintable_by_wallet_per_token ?? null,
      priceWei: stage.price ?? null,
    });
  }
  return { results, unknownStages };
}

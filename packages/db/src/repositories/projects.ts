/**
 * Project persistence: identity merge, provenance, and feed queries.
 *
 * Identity (PRD §7.2): canonical key is (chainId, contractAddress); until a
 * contract is known, a source-scoped alias keys the row and merges later,
 * transactionally, without creating duplicate user-visible projects.
 */

import {
  type Confidence,
  coerceDate,
  computeLifecycle,
  type LifecycleStatus,
  type StageKind,
} from "@hoodmint/core";
import type { SQL } from "drizzle-orm";
import { and, asc, desc, eq, gt, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import type { Db, Tx } from "../client.ts";
import { unwrapRows } from "../client.ts";
import {
  dropStages,
  evidence as evidenceTable,
  mintAggregates,
  mintEvents,
  projectAliases,
  projectFields,
  projects,
  providers,
  supplySnapshots,
} from "../schema.ts";
import { ensureProvider, type ProviderKind } from "./providers.ts";

export interface StageUpsert {
  readonly providerStageId: string;
  readonly label: string;
  readonly kind: StageKind;
  readonly priceWei: string | null;
  readonly currency: string | null;
  readonly maxPerWallet: number | null;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly paused: boolean;
}

export interface SupplyUpsert {
  readonly minted: bigint | null;
  readonly maxSupply: bigint | null;
  readonly verified: boolean;
  readonly source: string;
}

export interface ProjectUpsert {
  readonly providerKind: ProviderKind;
  readonly externalId: string;
  readonly chainId: number;
  readonly contractAddress: string | null;
  readonly name: string;
  readonly slug: string | null;
  readonly imageUrl: string | null;
  readonly confidence: Confidence;
  readonly stages: readonly StageUpsert[];
  readonly supply: SupplyUpsert | null;
  readonly evidence: {
    readonly kind: string;
    readonly fetchedAt: Date;
    readonly contentHash: string;
    readonly sanitizedPayload: unknown;
  } | null;
  readonly now: Date;
}

export interface UpsertResult {
  readonly projectId: string;
  readonly created: boolean;
  /** True when a conflicting contract identity was withheld (on-chain wins). */
  readonly contractConflict: boolean;
}

export async function upsertProjectFromSource(db: Db, input: ProjectUpsert): Promise<UpsertResult> {
  return db.transaction(async (tx) => {
    const provider = await ensureProvider(tx, input.providerKind);

    // 1. Resolve identity: contract first, alias second (PRD §7.2).
    let existing: { id: string; contractAddress: string | null } | undefined;
    if (input.contractAddress !== null) {
      const rows = await tx
        .select({ id: projects.id, contractAddress: projects.contractAddress })
        .from(projects)
        .where(
          and(
            eq(projects.chainId, input.chainId),
            eq(projects.contractAddress, input.contractAddress.toLowerCase()),
          ),
        )
        .limit(1);
      existing = rows[0];
    }
    if (existing === undefined) {
      const rows = await tx
        .select({ id: projects.id, contractAddress: projects.contractAddress })
        .from(projects)
        .innerJoin(projectAliases, eq(projectAliases.projectId, projects.id))
        .where(
          and(
            eq(projectAliases.providerId, provider.id),
            eq(projectAliases.externalId, input.externalId),
          ),
        )
        .limit(1);
      existing = rows[0];
    }

    let contractConflict = false;
    let projectId: string;

    if (existing === undefined) {
      const inserted = await tx
        .insert(projects)
        .values({
          chainId: input.chainId,
          contractAddress: input.contractAddress?.toLowerCase() ?? null,
          name: input.name,
          slug: input.slug,
          imageUrl: input.imageUrl,
          confidence: input.confidence,
          firstSeenAt: input.now,
          lastSeenAt: input.now,
        })
        .returning({ id: projects.id });
      projectId = inserted[0]?.id as string;
    } else {
      projectId = existing.id;
      // Contract identity conflicts: on-chain state wins; record the loser
      // as provenance instead of silently overwriting (PRD §7.2).
      if (
        input.contractAddress !== null &&
        existing.contractAddress !== null &&
        existing.contractAddress !== input.contractAddress.toLowerCase()
      ) {
        contractConflict = true;
        await tx.insert(projectFields).values({
          projectId,
          field: "contractAddress",
          valueJson: { value: input.contractAddress.toLowerCase(), provider: input.providerKind },
          providerId: provider.id,
          observedAt: input.now,
          isWinner: false,
        });
      } else if (input.contractAddress !== null && existing.contractAddress === null) {
        await tx
          .update(projects)
          .set({ contractAddress: input.contractAddress.toLowerCase() })
          .where(eq(projects.id, projectId));
      }
      await tx
        .update(projects)
        .set({
          name: input.name,
          // Slug-collision guard (found live 2026-08-28): OpenSea re-assigned
          // the slug "cat-verses" from one Catverse contract to another, so
          // updating this row's slug hit projects_slug_idx and the whole
          // collection sweep pass aborted. Only take the slug if no OTHER
          // project already owns it; otherwise keep ours.
          ...(input.slug !== null
            ? {
                slug: sql<string | null>`case
                  when exists (select 1 from projects p2
                                where p2.slug = ${input.slug} and p2.id <> ${projectId})
                  then ${projects.slug}
                  else ${input.slug}
                end`,
              }
            : {}),
          ...(input.imageUrl !== null ? { imageUrl: input.imageUrl } : {}),
          confidence: input.confidence,
          lastSeenAt: input.now,
        })
        .where(eq(projects.id, projectId));
    }

    // 2. Alias upsert — source-scoped external id (idempotent re-discovery).
    await tx
      .insert(projectAliases)
      .values({
        projectId,
        providerId: provider.id,
        externalId: input.externalId,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
      })
      .onConflictDoUpdate({
        target: [projectAliases.providerId, projectAliases.externalId],
        set: { projectId, lastSeenAt: input.now },
      });

    // 3. Evidence row (sanitized payload only, PRD §11).
    let evidenceId: string | null = null;
    if (input.evidence !== null) {
      const ev = await tx
        .insert(evidenceTable)
        .values({
          providerId: provider.id,
          kind: input.evidence.kind,
          fetchedAt: input.evidence.fetchedAt,
          contentHash: input.evidence.contentHash,
          sanitizedPayload: input.evidence.sanitizedPayload as Record<string, unknown>,
        })
        .returning({ id: evidenceTable.id });
      evidenceId = ev[0]?.id ?? null;
    }

    // 4. Stages: version bumps only on material change.
    for (const stage of input.stages) {
      // Match on the CANONICAL stage id (lowercase, dashless) so the dashed
      // and dashless spellings OpenSea uses on different endpoints resolve
      // to one row; rows stored in an old spelling are re-keyed on update.
      const currentRows = await tx
        .select()
        .from(dropStages)
        .where(
          and(
            eq(dropStages.projectId, projectId),
            sql`lower(replace(${dropStages.providerStageId}, '-', '')) = ${stage.providerStageId}`,
          ),
        )
        // Prefer the row already in canonical spelling (unique index safety),
        // then the freshest.
        .orderBy(
          desc(sql`(${dropStages.providerStageId} = ${stage.providerStageId})`),
          desc(dropStages.updatedAt),
        )
        .limit(1);
      const current = currentRows[0];
      if (current !== undefined && current.providerStageId !== stage.providerStageId) {
        await tx
          .update(dropStages)
          .set({ providerStageId: stage.providerStageId })
          .where(eq(dropStages.id, current.id));
      }
      const materialChange =
        current === undefined ||
        current.label !== stage.label ||
        current.type !== stage.kind ||
        current.priceWei !== stage.priceWei ||
        current.maxPerWallet !== stage.maxPerWallet ||
        current.startsAt.getTime() !== stage.startsAt.getTime() ||
        (current.endsAt?.getTime() ?? null) !== (stage.endsAt?.getTime() ?? null) ||
        current.paused !== stage.paused;

      if (current === undefined) {
        await tx.insert(dropStages).values({
          projectId,
          providerStageId: stage.providerStageId,
          version: 1,
          label: stage.label,
          type: stage.kind,
          priceWei: stage.priceWei,
          currency: stage.currency,
          maxPerWallet: stage.maxPerWallet,
          startsAt: stage.startsAt,
          endsAt: stage.endsAt,
          paused: stage.paused,
          rawEvidenceId: evidenceId,
        });
      } else if (materialChange) {
        await tx
          .update(dropStages)
          .set({
            version: current.version + 1,
            providerStageId: stage.providerStageId,
            label: stage.label,
            type: stage.kind,
            priceWei: stage.priceWei,
            currency: stage.currency,
            maxPerWallet: stage.maxPerWallet,
            startsAt: stage.startsAt,
            endsAt: stage.endsAt,
            paused: stage.paused,
            rawEvidenceId: evidenceId,
            updatedAt: input.now,
          })
          .where(eq(dropStages.id, current.id));
      }
    }

    // 4b. A DETAIL fetch is OpenSea's authoritative, complete stage list: any
    // stage row we hold that it no longer returns is stale (re-issued stage
    // uuid, removed phase) — pause it so feeds/eligibility/auto-mint stop
    // trusting it (kept for history, never deleted). Rows still stored in a
    // non-canonical spelling are duplicates of the (re-keyed) canonical row
    // and are paused too. List rows are partial (active/next only) and must
    // not do this.
    if (input.evidence?.kind === "drops:detail" && input.stages.length > 0) {
      const keep = input.stages.map((s) => s.providerStageId);
      await tx
        .update(dropStages)
        .set({ paused: true, updatedAt: input.now })
        .where(
          and(
            eq(dropStages.projectId, projectId),
            eq(dropStages.paused, false),
            sql`(${dropStages.providerStageId} not in (${sql.join(
              keep.map((k) => sql`${k}`),
              sql`, `,
            )}) or ${dropStages.providerStageId} <> lower(replace(${dropStages.providerStageId}, '-', '')))`,
          ),
        );
    }

    // 5. Supply snapshot with provenance.
    if (input.supply !== null && input.supply.minted !== null) {
      await tx.insert(supplySnapshots).values({
        projectId,
        minted: input.supply.minted,
        maxSupply: input.supply.maxSupply,
        observedAt: input.now,
        source: input.supply.source,
        verified: input.supply.verified,
        blockNumber: null,
      });
    }

    // 6. Recompute lifecycle (domain purity: status lives in core, PRD §6).
    const allStageRows = await tx
      .select()
      .from(dropStages)
      .where(eq(dropStages.projectId, projectId))
      .orderBy(asc(dropStages.startsAt));
    // Paused rows are either provider-paused stages or superseded duplicates
    // (step 4b). Neither may drive the lifecycle: only the active schedule
    // does, and the project is PAUSED only when NOTHING active remains
    // (seen live 2026-08-28: swoki flipped to PAUSED because its stale
    // duplicate row was paused while the real stage stayed open).
    const stageRows = allStageRows.filter((s) => !s.paused);
    const latestSupply = await latestSupplyFor(tx, projectId);
    const isoNow = input.now.toISOString();
    const lifecycle = computeLifecycle({
      stages: stageRows.map((s) => ({
        label: s.label,
        kind: s.type,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt?.toISOString() ?? null,
        paused: s.paused,
      })),
      isoNow,
      paused: allStageRows.length > 0 && stageRows.length === 0 ? true : null,
      supply: {
        minted: latestSupply?.minted ?? null,
        maxSupply: latestSupply?.maxSupply ?? null,
        verified: latestSupply?.verified ?? false,
      },
    });
    const nextStart = stageRows
      .map((s) => s.startsAt)
      .filter((t) => t.getTime() > input.now.getTime())
      .sort((a, b) => a.getTime() - b.getTime())[0];

    await tx
      .update(projects)
      .set({ lifecycleStatus: lifecycle, nextStageStart: nextStart ?? null })
      .where(eq(projects.id, projectId));

    return { projectId, created: existing === undefined, contractConflict };
  });
}

async function latestSupplyFor(
  tx: Tx,
  projectId: string,
): Promise<{ minted: bigint; maxSupply: bigint | null; verified: boolean } | undefined> {
  const rows = await tx
    .select()
    .from(supplySnapshots)
    .where(eq(supplySnapshots.projectId, projectId))
    .orderBy(desc(supplySnapshots.observedAt))
    .limit(1);
  const row = rows[0];
  return row === undefined
    ? undefined
    : { minted: row.minted, maxSupply: row.maxSupply, verified: row.verified };
}

/* ── Feed queries ─────────────────────────────────────────────────────────── */

export type FeedView = "all" | "live" | "next" | "latest" | "eligible" | "watchlist";

export type FeedSort = "recent" | "starting" | "velocity" | "minted" | "name" | "discovered";

export interface FeedFilters {
  readonly view: FeedView;
  readonly userId?: string | undefined;
  readonly search?: string | undefined;
  readonly status?: LifecycleStatus | undefined;
  readonly source?: string | undefined;
  readonly confidence?: Confidence | undefined;
  readonly price?: "free" | "paid" | undefined;
  readonly eligibility?: string | undefined;
  readonly watchedBy?: string | undefined;
  readonly firstSeenFrom?: Date | undefined;
  readonly firstSeenTo?: Date | undefined;
  readonly sort?: FeedSort | undefined;
  readonly limit?: number | undefined;
  /** Opaque keyset cursor from the previous page's meta.nextCursor. */
  readonly cursor?: string | undefined;
}

export interface ProjectSocials {
  readonly twitterUsername: string | null;
  readonly projectUrl: string | null;
  readonly discordUrl: string | null;
  readonly safelistStatus: string | null;
}

/** When the socials were last fetched (null = never), for refresh pacing. */
export async function projectSocialsFetchedAt(
  db: Db,
  slug: string,
): Promise<{ id: string; fetchedAt: Date | null } | undefined> {
  const rows = await db
    .select({ id: projects.id, fetchedAt: projects.socialsFetchedAt })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  return rows[0];
}

export async function updateProjectSocials(
  db: Db,
  projectId: string,
  socials: ProjectSocials,
  now: Date,
): Promise<void> {
  await db
    .update(projects)
    .set({
      twitterUsername: socials.twitterUsername,
      projectUrl: socials.projectUrl,
      discordUrl: socials.discordUrl,
      safelistStatus: socials.safelistStatus,
      socialsFetchedAt: now,
    })
    .where(eq(projects.id, projectId));
}

export interface FeedRow {
  readonly id: string;
  readonly chainId: number;
  readonly contractAddress: string | null;
  readonly name: string;
  readonly slug: string | null;
  readonly imageUrl: string | null;
  readonly twitterUsername: string | null;
  readonly projectUrl: string | null;
  readonly discordUrl: string | null;
  readonly safelistStatus: string | null;
  readonly confidence: Confidence;
  readonly lifecycleStatus: LifecycleStatus;
  readonly nextStageStart: Date | null;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly minted: string | null;
  readonly maxSupply: string | null;
  readonly supplyVerified: boolean;
  readonly velocity1h: number;
  readonly uniqueMinters1h: number;
  readonly stageLabel: string | null;
  readonly stageKind: StageKind | null;
  readonly stagePriceWei: string | null;
  /** Price of the NEXT (not-yet-open) stage — what an upcoming drop will
   *  cost; `stagePriceWei` is the active stage's and is null before open. */
  readonly nextStagePriceWei: string | null;
  readonly stageStartsAt: Date | null;
  readonly stageEndsAt: Date | null;
}

export interface FeedPage {
  readonly rows: FeedRow[];
  readonly nextCursor: string | null;
}

interface DecodedCursor {
  readonly v: string;
  readonly id: string;
}

function encodeCursor(row: FeedRow, sort: FeedSort): string | null {
  // Every timestamptz field on a query result is a string at runtime
  // regardless of what FeedRow's type claims (found live via a production
  // load test, not typecheck, 2026-08-22) — coerceDate before any Date
  // method, on every branch, not just the ones this session load-tested.
  let v: string;
  if (sort === "name") {
    v = row.name;
  } else if (sort === "starting" || sort === "velocity") {
    v = row.nextStageStart !== null ? coerceDate(row.nextStageStart).toISOString() : "infinity";
  } else if (sort === "discovered") {
    v = coerceDate(row.firstSeenAt).toISOString();
  } else if (sort === "minted") {
    v =
      row.maxSupply !== null && row.supplyVerified && row.minted !== null && row.maxSupply !== "0"
        ? `${(Number(BigInt(row.minted)) / Number(BigInt(row.maxSupply))).toFixed(6)}`
        : "";
  } else {
    v = coerceDate(row.lastSeenAt).toISOString();
  }
  return Buffer.from(JSON.stringify({ v, id: row.id } satisfies DecodedCursor)).toString(
    "base64url",
  );
}

function decodeCursor(raw: string): DecodedCursor | undefined {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<DecodedCursor>;
    if (typeof parsed.v === "string" && typeof parsed.id === "string") {
      return { v: parsed.v, id: parsed.id };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function queryFeed(db: Db, filters: FeedFilters): Promise<FeedPage> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const sort =
    filters.sort ??
    (filters.view === "latest" ? "discovered" : filters.view === "next" ? "starting" : "recent");

  const latestMinted = sql<string | null>`
    (select s.minted::text from supply_snapshots s
      where s.project_id = ${projects.id}
      order by s.observed_at desc limit 1)`;
  const latestMaxSupply = sql<string | null>`
    (select s.max_supply::text from supply_snapshots s
      where s.project_id = ${projects.id}
      order by s.observed_at desc limit 1)`;
  const latestVerified = sql<boolean>`
    coalesce((select s.verified from supply_snapshots s
      where s.project_id = ${projects.id}
      order by s.observed_at desc limit 1), false)`;

  const velocity1h = sql<number>`
    coalesce((select sum(a.quantity)::int
       from mint_aggregates a
      where a.project_id = ${projects.id}
        and a.bucket_size = '1h'
        and a.bucket_start > now() - interval '1 hour'), 0)`;

  const uniqueMinters1h = sql<number>`
    coalesce((select count(distinct m.recipient)::int
       from mint_events m
      where m.project_id = ${projects.id}
        and m.observed_at > now() - interval '1 hour'), 0)`;

  const conditions: SQL[] = [];

  switch (filters.view) {
    case "live":
      conditions.push(eq(projects.lifecycleStatus, "LIVE"));
      // Belt-and-braces: a LIVE row must actually have an open stage right
      // now (the minute-cadence lifecycle recompute usually keeps this
      // true, but never show an ended drop under "Live").
      conditions.push(
        sql`exists (select 1 from drop_stages s where s.project_id = ${projects.id}
              and not s.paused and s.starts_at <= now()
              and (s.ends_at is null or s.ends_at > now()))`,
      );
      break;
    case "next":
      conditions.push(eq(projects.lifecycleStatus, "NEXT"));
      break;
    case "latest":
      break;
    case "eligible": {
      conditions.push(
        sql`exists (select 1 from eligibility_checks ec
               where ec.project_id = ${projects.id}
                 and ec.status = 'ELIGIBLE_RESTRICTED')`,
      );
      break;
    }
    case "watchlist": {
      if (filters.userId === undefined) {
        return { rows: [], nextCursor: null };
      }
      conditions.push(
        sql`exists (select 1 from watchlist_entries we
               where we.project_id = ${projects.id} and we.user_id = ${filters.userId})`,
      );
      break;
    }
    case "all":
      break;
  }

  // Exclude unenriched on-chain radar placeholders — contracts the radar saw
  // minting but that carry no OpenSea metadata (no slug, name still "Unknown
  // 0x…"). They otherwise flood /all and /latest with tens of thousands of
  // imageless rows (found live 2026-08-28: 27k of 27k projects). They stay in
  // the DB — velocity/aggregates still track them and a dedicated on-chain
  // view can surface hot ones later — just not in the curated feeds.
  conditions.push(sql`not (${projects.slug} is null and ${projects.name} like 'Unknown %')`);
  // Chain-wide collection discovery (2026-08-28) surfaces every OpenSea
  // collection on the chain, most of which are NOT SeaDrop drops — no
  // schedule, lifecycle UNKNOWN forever. They're real projects (radar +
  // signals still track them) but noise in the drop feeds: keep the feeds to
  // projects that have at least one stage OR a resolved lifecycle.
  conditions.push(
    sql`(${projects.lifecycleStatus} <> 'UNKNOWN' or exists (select 1 from drop_stages ds where ds.project_id = ${projects.id}))`,
  );

  if (filters.status !== undefined) {
    conditions.push(eq(projects.lifecycleStatus, filters.status));
  }
  if (filters.confidence !== undefined) {
    conditions.push(eq(projects.confidence, filters.confidence));
  }
  if (filters.source !== undefined) {
    conditions.push(
      sql`exists (select 1 from project_aliases pa join providers pr on pr.id = pa.provider_id
             where pa.project_id = ${projects.id} and pr.kind = ${filters.source})`,
    );
  }
  if (filters.search !== undefined && filters.search.trim() !== "") {
    const q = `%${filters.search.trim()}%`;
    const exact = filters.search.trim().toLowerCase();
    const searchCond = or(
      ilike(projects.name, q),
      ilike(projects.slug, q),
      eq(projects.contractAddress, exact),
    );
    if (searchCond !== undefined) {
      conditions.push(searchCond);
    }
  }
  if (filters.firstSeenFrom !== undefined) {
    conditions.push(gte(projects.firstSeenAt, filters.firstSeenFrom));
  }
  if (filters.firstSeenTo !== undefined) {
    conditions.push(lte(projects.firstSeenAt, filters.firstSeenTo));
  }
  if (filters.price === "free") {
    conditions.push(sql`not exists (
      select 1 from drop_stages ds
       where ds.project_id = ${projects.id} and ds.price_wei is not null and ds.price_wei <> '0')`);
  } else if (filters.price === "paid") {
    conditions.push(sql`exists (
      select 1 from drop_stages ds
       where ds.project_id = ${projects.id} and ds.price_wei is not null and ds.price_wei <> '0')`);
  }
  if (filters.watchedBy !== undefined) {
    conditions.push(
      sql`exists (select 1 from watchlist_entries we
             where we.project_id = ${projects.id} and we.user_id = ${filters.watchedBy})`,
    );
  }
  if (filters.eligibility !== undefined && filters.view !== "eligible") {
    conditions.push(
      sql`exists (select 1 from eligibility_checks ec
             where ec.project_id = ${projects.id} and ec.status = ${filters.eligibility})`,
    );
  }

  // Keyset cursor: (sortValue, id) strictly after the last row of the page.
  if (filters.cursor !== undefined) {
    const decoded = decodeCursor(filters.cursor);
    if (decoded !== undefined) {
      const descSort = sort !== "starting" && sort !== "name";
      let sortExpr: SQL;
      let cursorValue: SQL;
      if (sort === "name") {
        sortExpr = sql`${projects.name}`;
        cursorValue = sql`${decoded.v}::text`;
      } else if (sort === "starting" || sort === "velocity") {
        sortExpr = sql`coalesce(${projects.nextStageStart}, 'infinity'::timestamptz)`;
        cursorValue =
          decoded.v === "infinity" ? sql`'infinity'::timestamptz` : sql`${decoded.v}::timestamptz`;
      } else if (sort === "discovered") {
        sortExpr = sql`${projects.firstSeenAt}`;
        cursorValue = sql`${decoded.v}::timestamptz`;
      } else if (sort === "minted") {
        sortExpr = sql`coalesce((select case when s.verified and s.max_supply is not null and s.max_supply > 0
              then (s.minted::numeric / s.max_supply::numeric) else null end
            from supply_snapshots s where s.project_id = ${projects.id}
            order by s.observed_at desc limit 1), -1)`;
        cursorValue = decoded.v === "" ? sql`-1::numeric` : sql`${decoded.v}::numeric`;
      } else {
        sortExpr = sql`${projects.lastSeenAt}`;
        cursorValue = sql`${decoded.v}::timestamptz`;
      }
      const comparison = descSort
        ? sql`(${sortExpr}, ${projects.id}) < (${cursorValue}, ${decoded.id}::uuid)`
        : sql`(${sortExpr}, ${projects.id}) > (${cursorValue}, ${decoded.id}::uuid)`;
      conditions.push(comparison);
    }
  }

  const orderBy =
    sort === "name"
      ? [asc(projects.name), asc(projects.id)]
      : sort === "starting" || sort === "velocity"
        ? [
            asc(sql`coalesce(${projects.nextStageStart}, 'infinity'::timestamptz)`),
            asc(projects.id),
          ]
        : sort === "discovered"
          ? [desc(projects.firstSeenAt), desc(projects.id)]
          : sort === "minted"
            ? [
                desc(sql`coalesce((select case when s.verified and s.max_supply is not null and s.max_supply > 0
                      then (s.minted::numeric / s.max_supply::numeric) else null end
                    from supply_snapshots s where s.project_id = ${projects.id}
                    order by s.observed_at desc limit 1), -1)`),
                desc(projects.id),
              ]
            : [desc(projects.lastSeenAt), desc(projects.id)];

  // Scalar per-column subqueries: Postgres has no tuple-projection syntax
  // for correlated subqueries; each field repeats the (cheap, indexed) lookup.
  // Both exclude paused stages: a stage OpenSea no longer publishes is
  // paused (not deleted) by the detail refresh, and a paused/stale row must
  // never be the one whose price/label the feed shows (found live
  // 2026-08-28: swoki showed a stale "FREE" from a superseded stage row).
  const currentStageCol = (col: string): SQL =>
    sql`(select ds.${sql.raw(col)} from drop_stages ds
      where ds.project_id = ${projects.id}
        and not ds.paused
        and ds.starts_at <= now()
        and (ds.ends_at is null or ds.ends_at > now())
      order by ds.updated_at desc, ds.starts_at asc limit 1)`;
  // The NEXT (not-yet-open) stage — what an upcoming drop will cost / when
  // it opens. Null once every stage has started.
  const nextStageCol = (col: string): SQL =>
    sql`(select ds.${sql.raw(col)} from drop_stages ds
      where ds.project_id = ${projects.id}
        and not ds.paused
        and ds.starts_at > now()
      order by ds.starts_at asc, ds.updated_at desc limit 1)`;

  const rows = await db
    .select({
      id: projects.id,
      chainId: projects.chainId,
      contractAddress: projects.contractAddress,
      name: projects.name,
      slug: projects.slug,
      imageUrl: projects.imageUrl,
      twitterUsername: projects.twitterUsername,
      projectUrl: projects.projectUrl,
      discordUrl: projects.discordUrl,
      safelistStatus: projects.safelistStatus,
      confidence: projects.confidence,
      lifecycleStatus: projects.lifecycleStatus,
      nextStageStart: projects.nextStageStart,
      firstSeenAt: projects.firstSeenAt,
      lastSeenAt: projects.lastSeenAt,
      minted: latestMinted,
      maxSupply: latestMaxSupply,
      supplyVerified: latestVerified,
      velocity1h,
      uniqueMinters1h,
      // Same double-wrap shape as the currentStageCol fields below and for
      // the same reason: a `${projects.id}` placed DIRECTLY in a select-list
      // sql template renders as an unqualified `"id"`, which inside the
      // correlated subselect resolves to `ds.id` — never matching, so this
      // came back null for every row (found live 2026-08-28 via toSQL()).
      // Wrapping the inner template keeps it rendered as "projects"."id".
      nextStagePriceWei: sql<string | null>`${nextStageCol("price_wei")}`,
      stageLabel: sql<string | null>`${currentStageCol("label")}`,
      stageKind: sql<StageKind | null>`${currentStageCol("type")}`,
      stagePriceWei: sql<string | null>`${currentStageCol("price_wei")}`,
      stageStartsAt: sql<Date | null>`${currentStageCol("starts_at")}`,
      stageEndsAt: sql<Date | null>`${currentStageCol("ends_at")}`,
    })
    .from(projects)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const lastRow = page[page.length - 1];
  return {
    rows: page as FeedRow[],
    nextCursor:
      rows.length > limit && lastRow !== undefined ? encodeCursor(lastRow as FeedRow, sort) : null,
  };
}

/* ── Detail ───────────────────────────────────────────────────────────────── */

/**
 * Time-based lifecycle recompute, DB-only, no API call (owner report
 * 2026-08-28: /live showed drops whose stage had already ended). Lifecycle
 * is otherwise only recomputed when a project is re-upserted, so a LIVE
 * drop whose last stage ends stays LIVE until OpenSea is re-fetched. Run
 * every minute: LIVE→ENDED when nothing is open and nothing is upcoming,
 * LIVE→NEXT when only a future stage remains, NEXT→LIVE when a stage opened.
 * Returns rows changed.
 */
export async function recomputeLifecycles(db: Db): Promise<number> {
  // SOLD_OUT wins over the schedule (core/status.ts rule, mirrored in SQL):
  // the latest VERIFIED supply snapshot with minted >= max. A drop whose
  // supply went in an earlier phase must never sit under /live (seen live
  // 2026-08-28: crypto2punk2robinhood 5000/5000 shown LIVE; Goat Street
  // "WL FCFS" armed with zero supply left).
  const rows = await db.execute(sql`
    with st as (
      select p.id,
        exists (select 1 from drop_stages s where s.project_id = p.id and not s.paused
                  and s.starts_at <= now() and (s.ends_at is null or s.ends_at > now())) as live,
        (select min(s.starts_at) from drop_stages s where s.project_id = p.id and not s.paused
                  and s.starts_at > now()) as next_start,
        exists (select 1 from drop_stages s where s.project_id = p.id) as has_stages,
        coalesce((select ss.verified and ss.max_supply is not null and ss.minted >= ss.max_supply
                    from supply_snapshots ss where ss.project_id = p.id
                   order by ss.observed_at desc limit 1), false) as sold_out
      from projects p
      where p.lifecycle_status in ('LIVE', 'NEXT', 'SOLD_OUT', 'PAUSED')
    )
    update projects p
       set lifecycle_status = case
             when st.sold_out then 'SOLD_OUT'
             when st.live then 'LIVE'
             when st.next_start is not null then 'NEXT'
             when st.has_stages then 'ENDED'
             else p.lifecycle_status end,
           next_stage_start = st.next_start,
           updated_at = now()
      from st
     where st.id = p.id
       and (
         p.lifecycle_status <> case
             when st.sold_out then 'SOLD_OUT'
             when st.live then 'LIVE'
             when st.next_start is not null then 'NEXT'
             when st.has_stages then 'ENDED'
             else p.lifecycle_status end
         or p.next_stage_start is distinct from st.next_start
       )
    returning p.id
  `);
  return unwrapRows<{ id: string }>(rows).length;
}

/** LIVE/NEXT projects with a contract — the on-chain supply sweep's targets. */
export async function supplySweepTargets(
  db: Db,
  limit: number,
): Promise<{ id: string; slug: string | null; contractAddress: string }[]> {
  const rows = await db
    .select({ id: projects.id, slug: projects.slug, contractAddress: projects.contractAddress })
    .from(projects)
    .where(
      and(
        inArray(projects.lifecycleStatus, ["LIVE", "NEXT"]),
        sql`${projects.contractAddress} is not null`,
      ),
    )
    .orderBy(asc(sql`coalesce(${projects.nextStageStart}, 'infinity'::timestamptz)`))
    .limit(limit);
  return rows.filter(
    (r): r is typeof r & { contractAddress: string } => r.contractAddress !== null,
  );
}

/** Record a VERIFIED on-chain supply reading (totalSupply / maxSupply). */
export async function recordChainSupply(
  db: Db,
  projectId: string,
  reading: { minted: bigint; maxSupply: bigint | null; blockNumber: bigint | null },
  now: Date,
): Promise<void> {
  await db.insert(supplySnapshots).values({
    projectId,
    minted: reading.minted,
    maxSupply: reading.maxSupply,
    observedAt: now,
    source: "chain:erc721",
    verified: reading.maxSupply !== null,
    blockNumber: reading.blockNumber,
  });
}

export interface ProjectDetail {
  readonly project: typeof projects.$inferSelect;
  readonly stages: (typeof dropStages.$inferSelect)[];
  readonly supply: (typeof supplySnapshots.$inferSelect)[] | [];
  readonly aliases: { providerKind: string; externalId: string; lastSeenAt: Date }[];
  readonly conflicts: {
    field: string;
    valueJson: unknown;
    providerKind: string | null;
    observedAt: Date;
  }[];
  readonly evidenceRows: { id: string; kind: string; fetchedAt: Date; contentHash: string }[];
}

export async function getProjectDetail(db: Db, id: string): Promise<ProjectDetail | undefined> {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  const project = rows[0];
  if (project === undefined) {
    return undefined;
  }
  const [stages, supply, aliases, conflicts, evidenceRows] = await Promise.all([
    db
      .select()
      .from(dropStages)
      .where(eq(dropStages.projectId, id))
      .orderBy(asc(dropStages.startsAt)),
    db
      .select()
      .from(supplySnapshots)
      .where(eq(supplySnapshots.projectId, id))
      .orderBy(desc(supplySnapshots.observedAt))
      .limit(20),
    db
      .select({
        providerKind: providers.kind,
        externalId: projectAliases.externalId,
        lastSeenAt: projectAliases.lastSeenAt,
      })
      .from(projectAliases)
      .innerJoin(providers, eq(providers.id, projectAliases.providerId))
      .where(eq(projectAliases.projectId, id)),
    db
      .select({
        field: projectFields.field,
        valueJson: projectFields.valueJson,
        providerKind: providers.kind,
        observedAt: projectFields.observedAt,
      })
      .from(projectFields)
      .leftJoin(providers, eq(providers.id, projectFields.providerId))
      .where(and(eq(projectFields.projectId, id), eq(projectFields.isWinner, false)))
      .orderBy(desc(projectFields.observedAt))
      .limit(20),
    db
      .select({
        id: evidenceTable.id,
        kind: evidenceTable.kind,
        fetchedAt: evidenceTable.fetchedAt,
        contentHash: evidenceTable.contentHash,
      })
      .from(evidenceTable)
      .orderBy(desc(evidenceTable.fetchedAt))
      .limit(10),
  ]);

  return { project, stages, supply: supply, aliases, conflicts, evidenceRows };
}

export async function recentMintEvents(
  db: Db,
  projectId: string,
  limit = 25,
): Promise<(typeof mintEvents.$inferSelect)[]> {
  return db
    .select()
    .from(mintEvents)
    .where(eq(mintEvents.projectId, projectId))
    .orderBy(desc(mintEvents.blockNumber))
    .limit(limit);
}

export async function velocitySeries(
  db: Db,
  projectId: string,
): Promise<{ bucketStart: Date; quantity: number; uniqueRecipients: number }[]> {
  return db
    .select({
      bucketStart: mintAggregates.bucketStart,
      quantity: mintAggregates.quantity,
      uniqueRecipients: mintAggregates.uniqueRecipients,
    })
    .from(mintAggregates)
    .where(and(eq(mintAggregates.projectId, projectId), eq(mintAggregates.bucketSize, "5m")))
    .orderBy(desc(mintAggregates.bucketStart))
    .limit(48);
}

export async function countProjects(db: Db): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(projects);
  return rows[0]?.count ?? 0;
}

export async function projectsWithContract(
  db: Db,
  chainId: number,
): Promise<{ id: string; contractAddress: string | null }[]> {
  return db
    .select({ id: projects.id, contractAddress: projects.contractAddress })
    .from(projects)
    .where(and(eq(projects.chainId, chainId), sql`${projects.contractAddress} is not null`));
}

export async function dueEligibilityCandidates(
  db: Db,
  now: Date,
  limit: number,
): Promise<{ projectId: string; slug: string | null }[]> {
  return db
    .select({ projectId: projects.id, slug: projects.slug })
    .from(projects)
    .where(
      and(
        inArray(projects.lifecycleStatus, ["LIVE", "NEXT", "UNKNOWN"]),
        gt(projects.lastSeenAt, new Date(now.getTime() - 7 * 24 * 3600 * 1000)),
      ),
    )
    .orderBy(asc(sql`coalesce(${projects.nextStageStart}, 'infinity'::timestamptz)`))
    .limit(limit);
}

export interface UpcomingStage {
  readonly stageId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectSlug: string | null;
  readonly stageLabel: string;
  readonly stagePriceWei: string | null;
  readonly stageMaxPerWallet: number | null;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
}

/**
 * Stages opening within `maxWindowMinutes` from now — not yet started, not
 * paused — candidates for stage_starting alerts (PRD §7.4). Callers narrow
 * further to the exact configured window(s) a stage has crossed with
 * `dueStageStartingWindows` from `@hoodmint/core`.
 */
export async function upcomingDropStages(
  db: Db,
  now: Date,
  maxWindowMinutes: number,
): Promise<UpcomingStage[]> {
  const cutoff = new Date(now.getTime() + maxWindowMinutes * 60_000);
  const rows = await db
    .select({
      stageId: dropStages.id,
      projectId: dropStages.projectId,
      projectName: projects.name,
      projectSlug: projects.slug,
      stageLabel: dropStages.label,
      stagePriceWei: dropStages.priceWei,
      stageMaxPerWallet: dropStages.maxPerWallet,
      startsAt: dropStages.startsAt,
      endsAt: dropStages.endsAt,
    })
    .from(dropStages)
    .innerJoin(projects, eq(projects.id, dropStages.projectId))
    .where(
      and(
        gt(dropStages.startsAt, now),
        lte(dropStages.startsAt, cutoff),
        eq(dropStages.paused, false),
      ),
    )
    .orderBy(asc(dropStages.startsAt));
  return rows;
}

/**
 * Look a project up by its collection contract address. Addresses are stored
 * lowercased by the upsert path, so the caller's input is lowercased here
 * rather than relying on a case-insensitive comparison that could not use
 * the `projects_chain_contract_idx` unique index.
 */
export async function findProjectByContractAddress(
  db: Db,
  contractAddress: string,
): Promise<typeof projects.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.contractAddress, contractAddress.toLowerCase()))
    .limit(1);
  return rows[0];
}

export async function findProjectBySlugOrId(
  db: Db,
  key: string,
): Promise<typeof projects.$inferSelect | undefined> {
  const bySlug = await db.select().from(projects).where(eq(projects.slug, key)).limit(1);
  return bySlug[0];
}

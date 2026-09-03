/**
 * On-chain mint persistence: log dedupe by (chainId, txHash, logIndex),
 * finalized/unfinalized reorg handling, and 5m/1h aggregate maintenance
 * (PRD §7.1). Rolling-window activity is never treated as total supply.
 */
import {
  computeHolderConcentration,
  deriveHolderConcentration,
  type HolderConcentration,
} from "@hoodmint/core";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { holderSnapshots, mintActivitySnapshots, mintEvents, projects } from "../schema.ts";

export interface MintEventInsert {
  readonly chainId: number;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly contractAddress: string;
  readonly recipient: string;
  readonly quantity: number;
  readonly finalized: boolean;
  readonly observedAt: Date;
}

/**
 * Insert mint events idempotently; resolves contract → project. Returns the
 * number of genuinely new rows (duplicates skipped via unique constraint).
 */
export async function insertMintEvents(
  db: Db,
  events: readonly MintEventInsert[],
): Promise<number> {
  if (events.length === 0) {
    return 0;
  }
  const contracts = [...new Set(events.map((e) => e.contractAddress.toLowerCase()))];
  // Addresses here come from ChainRadar's ABI-decoded event logs, not free
  // text, so the prior string-interpolated-array-literal form (escaped via
  // .replace(/'/g, "''")) was already structurally safe — but parameterized
  // inArray() is the same defense-in-depth fix already applied to
  // eligibility.ts's walletChipsForProjects, and this codebase's own
  // convention (schema.ts's header comment) already stores addresses
  // lowercase canonical, so a plain inArray on contractAddress (no lower()
  // needed) replaces the raw SQL entirely rather than just hardening it.
  const projectRows = await db
    .select({ id: projects.id, contractAddress: projects.contractAddress })
    .from(projects)
    .where(and(isNotNull(projects.contractAddress), inArray(projects.contractAddress, contracts)));
  const byContract = new Map(
    projectRows.map((row) => [row.contractAddress?.toLowerCase(), row.id]),
  );

  // Unseen contracts become placeholder projects so events stay linked and
  // the radar surfaces non-featured mints (PRD goal 2); confidence stays
  // single-source until OpenSea corroborates.
  const observedAt = events[0]?.observedAt ?? new Date();
  for (const contract of contracts) {
    if (!byContract.has(contract)) {
      const id = await ensureContractProject(
        db,
        events[0]?.chainId ?? 4663,
        contract,
        `Unknown ${contract.slice(0, 10)}`,
        observedAt,
      );
      byContract.set(contract, id);
    }
  }

  let inserted = 0;
  for (const event of events) {
    const projectId = byContract.get(event.contractAddress.toLowerCase());
    const rows = await db
      .insert(mintEvents)
      .values({
        chainId: event.chainId,
        txHash: event.txHash.toLowerCase(),
        logIndex: event.logIndex,
        blockNumber: event.blockNumber,
        blockHash: event.blockHash.toLowerCase(),
        ...(projectId !== undefined ? { projectId } : {}),
        recipient: event.recipient.toLowerCase(),
        quantity: event.quantity,
        finalized: event.finalized,
        observedAt: event.observedAt,
      })
      .onConflictDoNothing({ target: [mintEvents.chainId, mintEvents.txHash, mintEvents.logIndex] })
      .returning({ id: mintEvents.id });
    inserted += rows.length;
  }
  return inserted;
}

/**
 * Resolve a set of contract addresses to their project ids via a proper
 * parameterized `inArray` (finding #2, code review 2026-08-23): the chain
 * worker previously hand-rolled this as a comma-joined, pre-quoted string
 * interpolated into a raw `sql` template, which drizzle bound as ONE text
 * parameter — so `any(array[$1])` was a single-element array holding the
 * literal `'0xabc','0xdef'` (quotes and all) and matched zero projects,
 * silently starving refreshAggregates/refreshHolderSnapshot on the real
 * trigger path. Addresses are stored lowercase-canonical (schema header),
 * so a plain inArray on the lowercased set is correct and injection-proof.
 */
export async function projectIdsForContracts(
  db: Db,
  contracts: readonly string[],
): Promise<string[]> {
  if (contracts.length === 0) {
    return [];
  }
  const lowered = [...new Set(contracts.map((c) => c.toLowerCase()))];
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(isNotNull(projects.contractAddress), inArray(projects.contractAddress, lowered)));
  return rows.map((r) => r.id);
}

/** Recompute 5m and 1h aggregates from finalized+unfinalized events (idempotent). */
export async function refreshAggregates(db: Db, projectId: string): Promise<void> {
  await db.execute(sql`
    insert into mint_aggregates (project_id, bucket_start, bucket_size, quantity, unique_recipients, updated_at)
    select project_id, date_trunc('hour', observed_at) + floor(extract(minute from observed_at) / 5) * interval '5 min' as bucket,
           '5m', sum(quantity)::int, count(distinct recipient)::int, now()
      from mint_events
     where project_id = ${projectId}
       and observed_at > now() - interval '48 hours'
     group by 1, 2
    on conflict (project_id, bucket_start, bucket_size)
      do update set quantity = excluded.quantity, unique_recipients = excluded.unique_recipients, updated_at = now()
  `);
  await db.execute(sql`
    insert into mint_aggregates (project_id, bucket_start, bucket_size, quantity, unique_recipients, updated_at)
    select project_id, date_trunc('hour', observed_at), '1h', sum(quantity)::int, count(distinct recipient)::int, now()
      from mint_events
     where project_id = ${projectId}
       and observed_at > now() - interval '48 hours'
     group by 1, 2
    on conflict (project_id, bucket_start, bucket_size)
      do update set quantity = excluded.quantity, unique_recipients = excluded.unique_recipients, updated_at = now()
  `);
  await refreshActivitySnapshot(db, projectId);
}

/** Exact rolling-one-hour snapshot consumed by feed and automation reads. */
export async function refreshActivitySnapshot(db: Db, projectId: string): Promise<void> {
  await db.execute(sql`
    insert into mint_activity_snapshots
      (project_id, window_started_at, computed_at, quantity, unique_recipients)
    select ${projectId}::uuid,
           now() - interval '1 hour',
           now(),
           coalesce(sum(quantity), 0)::int,
           count(distinct recipient)::int
      from mint_events
     where project_id = ${projectId}
       and observed_at > now() - interval '1 hour'
    on conflict (project_id) do update set
      window_started_at = excluded.window_started_at,
      computed_at = excluded.computed_at,
      quantity = excluded.quantity,
      unique_recipients = excluded.unique_recipients
  `);
}

/**
 * Refresh active projects even when no new event arrives, so a rolling
 * window naturally decays to zero. Recently-computed snapshots get one more
 * hour of refreshes after a project leaves LIVE, preserving truthful recent
 * activity on Latest/All without scanning every historical project.
 */
export async function refreshLiveActivitySnapshots(db: Db): Promise<number> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .leftJoin(mintActivitySnapshots, eq(mintActivitySnapshots.projectId, projects.id))
    .where(
      sql`${projects.lifecycleStatus} = 'LIVE'
        or ${mintActivitySnapshots.computedAt} > now() - interval '1 hour'`,
    );
  for (const row of rows) {
    await refreshActivitySnapshot(db, row.id);
  }
  return rows.length;
}

/**
 * Whale / holder-concentration snapshot (feature-backlog.md §2, shipped
 * 2026-08-22): recompute from every mint_events row for this project
 * (finalized and unfinalized, same recency-over-strict-finality tradeoff
 * refreshAggregates above already makes for this same event stream) and
 * upsert the single current snapshot. Called from the same "touched
 * projects" loop as refreshAggregates (apps/worker/src/workers/chain.ts)
 * — same trigger, same cadence, no new schedule needed.
 */
export async function refreshHolderSnapshot(db: Db, projectId: string): Promise<void> {
  const rows = await db
    .select({
      recipient: mintEvents.recipient,
      quantity: sql<number>`sum(${mintEvents.quantity})::int`.as("quantity"),
    })
    .from(mintEvents)
    .where(eq(mintEvents.projectId, projectId))
    .groupBy(mintEvents.recipient);

  const concentration = computeHolderConcentration(rows);
  await db
    .insert(holderSnapshots)
    .values({
      projectId,
      totalMinted: concentration.totalMinted,
      uniqueHolders: concentration.uniqueHolders,
      topHolders: concentration.topHolders.map((h) => ({
        recipient: h.recipient,
        quantity: h.quantity,
      })),
      computedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: holderSnapshots.projectId,
      set: {
        totalMinted: concentration.totalMinted,
        uniqueHolders: concentration.uniqueHolders,
        topHolders: concentration.topHolders.map((h) => ({
          recipient: h.recipient,
          quantity: h.quantity,
        })),
        computedAt: new Date(),
      },
    });
}

/**
 * Read the current snapshot and re-derive percentages at read time (never
 * stored — see the schema comment on holder_snapshots). Returns null if no
 * mint has ever been recorded for this project yet.
 */
export async function getHolderConcentration(
  db: Db,
  projectId: string,
): Promise<(HolderConcentration & { readonly computedAt: Date }) | null> {
  const [row] = await db
    .select()
    .from(holderSnapshots)
    .where(eq(holderSnapshots.projectId, projectId))
    .limit(1);
  if (row === undefined) {
    return null;
  }
  // Plain .select() with no raw SQL touching this query — computedAt comes
  // back as a real Date, not a string (see docs/execution-architecture.md's
  // sixth pass on why that distinction matters in this codebase).
  // deriveHolderConcentration, not computeHolderConcentration: row.topHolders
  // is already truncated to the top 10, so re-summing it would silently
  // undercount totalMinted — row.totalMinted/uniqueHolders are the true
  // full-set values computed once at refresh time.
  return {
    ...deriveHolderConcentration({
      totalMinted: row.totalMinted,
      uniqueHolders: row.uniqueHolders,
      topHolders: row.topHolders,
    }),
    computedAt: row.computedAt,
  };
}

export async function ensureContractProject(
  db: Db,
  chainId: number,
  contractAddress: string,
  name: string,
  now: Date,
): Promise<string> {
  const existing = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.chainId, chainId),
        eq(projects.contractAddress, contractAddress.toLowerCase()),
      ),
    )
    .limit(1);
  if (existing[0] !== undefined) {
    return existing[0].id;
  }
  const inserted = await db
    .insert(projects)
    .values({
      chainId,
      contractAddress: contractAddress.toLowerCase(),
      name,
      confidence: "single-source",
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [projects.chainId, projects.contractAddress],
      targetWhere: sql`contract_address is not null`,
      set: { lastSeenAt: now },
    })
    .returning({ id: projects.id });
  return inserted[0]?.id as string;
}

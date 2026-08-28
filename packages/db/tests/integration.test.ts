/**
 * Integration suite (PRD §15) — requires real PostgreSQL (migrated) and
 * exercises: identity merge idempotency, feed queries, outbox claiming, and
 * reorg replay marking. Run via scripts/integration-tests.sh.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  armedPlansWithStageStart,
  armMintPlan,
  auditLogs,
  bestEligibilityByProject,
  cacheMintPlanTx,
  cancelOpenPlansForWallet,
  claimArmedMintPlan,
  claimDueAlerts,
  clearPresignedForWallet,
  clearWalletSigningKey,
  createDb,
  createMintPlan,
  createRpcEndpoint,
  createSigner,
  dbClient,
  disarmMintPlan,
  distinctEnabledRpcChainIds,
  dropStages,
  enqueueAlert,
  ensureProvider,
  expireStaleMintPlans,
  failMintPlanExecution,
  getCheckpoint,
  getHolderConcentration,
  getRaritySnapshot,
  getWalletSigningKeySealed,
  insertMintEvents,
  insertSignal,
  latestSignal,
  latestSignalsForProject,
  markAlertSent,
  markMintPlanExecuted,
  mintEvents,
  mintPlans,
  plansNeedingPreBuild,
  projectIdsForContracts,
  projectsForSentimentScan,
  queryFeed,
  recordAudit,
  refreshHolderSnapshot,
  releaseMintPlanToArmed,
  resealWalletSigningKey,
  saveCheckpoint,
  savePresignedTx,
  saveRaritySnapshot,
  scrubKeyTracesForAddress,
  setWalletSigningKey,
  unfinalizeFromBlock,
  upsertEligibilityCheck,
  upsertProjectFromSource,
  user,
  vacuumKeyTables,
  walletChipsForProjects,
  wallets,
  walletsWithLegacySealedKey,
} from "../src/index.ts";

function unwrap<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

const DB_URL = process.env.DATABASE_URL;
if (DB_URL === undefined || DB_URL === undefined) {
  throw new Error("DATABASE_URL must point at the integration PostgreSQL");
}

const db = createDb(DB_URL, { max: 4 });
const NOW = new Date();
const H = 3600_000;

async function cleanup(): Promise<void> {
  await db.execute(sql`truncate table
    mint_events, mint_aggregates, holder_snapshots, rarity_snapshots, supply_snapshots, drop_stages,
    eligibility_checks, notification_outbox, notification_attempts,
    mint_plans, signers, "user", audit_logs,
    project_aliases, project_fields, evidence, projects, providers,
    chain_checkpoints, wallets, alert_channels, settings restart identity cascade`);
}

beforeAll(cleanup);
afterAll(async () => {
  await dbClient(db).end({ timeout: 5 });
});

const baseProject = {
  providerKind: "opensea" as const,
  externalId: `it-${randomUUID().slice(0, 8)}`,
  chainId: 4663,
  contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
  name: "Integration Droid",
  slug: null,
  imageUrl: null,
  confidence: "single-source" as const,
  supply: { minted: 10n, maxSupply: 100n, verified: true, source: "opensea" },
  evidence: null,
};

describe("identity merge and idempotency (PRD §7.2)", () => {
  it("upserts the same source twice without duplicating projects", async () => {
    const stages = [
      {
        providerStageId: "s1",
        label: "WL",
        kind: "allowlist" as const,
        priceWei: "1000",
        currency: null,
        maxPerWallet: 2,
        startsAt: new Date(NOW.getTime() - H),
        endsAt: new Date(NOW.getTime() + H),
        paused: false,
      },
    ];
    const first = await upsertProjectFromSource(db, { ...baseProject, stages, now: NOW });
    const second = await upsertProjectFromSource(db, { ...baseProject, stages, now: NOW });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.projectId).toBe(first.projectId);

    const counts = await db.execute(
      sql`select count(*)::int as c from projects where id = ${first.projectId}::uuid`,
    );
    expect(rowsOf<{ c: number }>(counts)[0]?.c ?? 0).toBe(1);
  });

  it("merges an alias-discovered project when the contract appears later", async () => {
    const externalId = `it-${randomUUID().slice(0, 8)}`;
    const noContract = await upsertProjectFromSource(db, {
      ...baseProject,
      externalId,
      contractAddress: null,
      stages: [],
      supply: null,
      now: NOW,
    });
    const withContract = await upsertProjectFromSource(db, {
      ...baseProject,
      externalId,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      stages: [],
      supply: null,
      now: NOW,
    });
    expect(withContract.projectId).toBe(noContract.projectId);
  });

  it("withholds conflicting contract identity instead of overwriting", async () => {
    const externalId = `it-${randomUUID().slice(0, 8)}`;
    const contract = `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`;
    await upsertProjectFromSource(db, {
      ...baseProject,
      externalId,
      contractAddress: contract,
      stages: [],
      supply: null,
      now: NOW,
    });
    const conflicting = await upsertProjectFromSource(db, {
      ...baseProject,
      externalId,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      stages: [],
      supply: null,
      now: NOW,
    });
    expect(conflicting.contractConflict).toBe(true);
  });
});

describe("feed queries (PRD §5/§9)", () => {
  it("filters by view/status/search and paginates with cursors", async () => {
    const liveSlug = `it-live-${randomUUID().slice(0, 6)}`;
    await upsertProjectFromSource(db, {
      ...baseProject,
      // Every fixture in this describe block must get its own contract
      // address — baseProject's is a single fixed value, and reusing it
      // across what should be independent projects makes them merge onto
      // one project row via the (chainId, contractAddress) identity index,
      // with only the last write's name surviving (found via live
      // integration testing, 2026-08-22 — this silently broke this exact
      // assertion, while the product's own lifecycle logic was correct).
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      externalId: liveSlug,
      slug: liveSlug,
      name: "Live One",
      stages: [
        {
          providerStageId: "live",
          label: "Public",
          kind: "public",
          priceWei: "0",
          currency: null,
          maxPerWallet: 3,
          startsAt: new Date(NOW.getTime() - H),
          endsAt: new Date(NOW.getTime() + H),
          paused: false,
        },
      ],
      now: NOW,
    });
    for (let i = 0; i < 3; i += 1) {
      await upsertProjectFromSource(db, {
        ...baseProject,
        contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
        externalId: `it-next-${i}-${randomUUID().slice(0, 6)}`,
        name: `Next ${i}`,
        stages: [
          {
            providerStageId: `next-${i}`,
            label: "WL",
            kind: "allowlist",
            priceWei: "1",
            currency: null,
            maxPerWallet: 1,
            startsAt: new Date(NOW.getTime() + (i + 1) * H),
            endsAt: new Date(NOW.getTime() + (i + 2) * H),
            paused: false,
          },
        ],
        supply: null,
        now: NOW,
      });
    }

    const live = await queryFeed(db, { view: "live", limit: 10 });
    expect(live.rows.some((row) => row.name === "Live One")).toBe(true);

    const next = await queryFeed(db, { view: "next", sort: "starting", limit: 2 });
    expect(next.rows).toHaveLength(2);
    expect(next.nextCursor).not.toBeNull();
    const page2 = await queryFeed(db, {
      view: "next",
      sort: "starting",
      limit: 2,
      cursor: next.nextCursor ?? undefined,
    });
    const allNames = [...next.rows, ...page2.rows].map((r) => r.name);
    expect(new Set(allNames).size).toBe(allNames.length);

    const search = await queryFeed(db, { view: "all", search: "Live One" });
    expect(search.rows.every((row) => row.name.includes("Live") || row.name === "Live One")).toBe(
      true,
    );

    const free = await queryFeed(db, { view: "all", price: "free" });
    expect(free.rows.some((row) => row.name === "Live One")).toBe(true);
  });
});

describe("eligibility scoping (perf finding, 2026-08-22)", () => {
  it("scopes bestEligibilityByProject to given project ids and short-circuits on empty", async () => {
    const [wallet] = await db
      .insert(wallets)
      .values({ address: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`, enabled: true })
      .returning();
    if (wallet === undefined) throw new Error("wallet insert returned no row");

    const scoped = await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      externalId: `it-scoped-${randomUUID().slice(0, 6)}`,
      name: "Scoped Target",
      stages: [
        {
          providerStageId: "s",
          label: "WL",
          kind: "allowlist",
          priceWei: "1",
          currency: null,
          maxPerWallet: 1,
          startsAt: new Date(NOW.getTime() + H),
          endsAt: new Date(NOW.getTime() + 2 * H),
          paused: false,
        },
      ],
      now: NOW,
    });
    const unscoped = await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      externalId: `it-unscoped-${randomUUID().slice(0, 6)}`,
      name: "Off-page Project",
      stages: [
        {
          providerStageId: "s",
          label: "WL",
          kind: "allowlist",
          priceWei: "1",
          currency: null,
          maxPerWallet: 1,
          startsAt: new Date(NOW.getTime() + H),
          endsAt: new Date(NOW.getTime() + 2 * H),
          paused: false,
        },
      ],
      now: NOW,
    });

    const [scopedStage] = await db
      .select()
      .from(dropStages)
      .where(eq(dropStages.projectId, scoped.projectId));
    const [unscopedStage] = await db
      .select()
      .from(dropStages)
      .where(eq(dropStages.projectId, unscoped.projectId));
    if (scopedStage === undefined || unscopedStage === undefined) {
      throw new Error("stage fixture missing");
    }

    await upsertEligibilityCheck(db, {
      walletId: wallet.id,
      projectId: scoped.projectId,
      stageId: scopedStage.id,
      status: "ELIGIBLE_RESTRICTED",
      checkedAt: NOW,
      nextDueAt: null,
    });
    await upsertEligibilityCheck(db, {
      walletId: wallet.id,
      projectId: unscoped.projectId,
      stageId: unscopedStage.id,
      status: "PUBLIC_ONLY",
      checkedAt: NOW,
      nextDueAt: null,
    });

    // Unscoped (Pulse dashboard's use case): sees every project's status.
    const full = await bestEligibilityByProject(db);
    expect(full.get(scoped.projectId)).toBe("ELIGIBLE_RESTRICTED");
    expect(full.get(unscoped.projectId)).toBe("PUBLIC_ONLY");

    // Scoped to just the "current page" (feed/API's use case): only the
    // requested project appears, even though the other one has a row too —
    // this is the actual behavior the load-test-driven fix depends on.
    const scopedResult = await bestEligibilityByProject(db, [scoped.projectId]);
    expect(scopedResult.get(scoped.projectId)).toBe("ELIGIBLE_RESTRICTED");
    expect(scopedResult.has(unscoped.projectId)).toBe(false);
    expect(scopedResult.size).toBe(1);

    // Empty ids short-circuits without touching the eligible-but-off-page row.
    const empty = await bestEligibilityByProject(db, []);
    expect(empty.size).toBe(0);

    // Regression guard for the walletChipsForProjects raw-SQL-interpolation
    // fix (now parameterized via drizzle's inArray, not string-built SQL).
    const chips = await walletChipsForProjects(db, [wallet.id]);
    expect(chips.get(`${wallet.id}:${scoped.projectId}`)).toBe("ELIGIBLE_RESTRICTED");
    expect(chips.get(`${wallet.id}:${unscoped.projectId}`)).toBe("PUBLIC_ONLY");
  });
});

describe("outbox claiming (PRD §7.4)", () => {
  it("claims due alerts exactly once and marks sent after ack", async () => {
    const key = `it-${randomUUID()}`;
    const inserted = await enqueueAlert(db, {
      dedupeKey: key,
      alertType: "restricted_eligible",
      thresholdMinutes: 0,
      payload: { text: "test" },
    });
    expect(inserted).toBe(true);
    expect(
      await enqueueAlert(db, {
        dedupeKey: key,
        alertType: "restricted_eligible",
        thresholdMinutes: 0,
        payload: { text: "test" },
      }),
    ).toBe(false);

    const claimed = await claimDueAlerts(db, new Date(), 10);
    const mine = claimed.find((a) => a.dedupeKey === key);
    expect(mine).toBeDefined();
    expect(mine?.attempts).toBe(1);

    const again = await claimDueAlerts(db, new Date(), 10);
    expect(again.find((a) => a.dedupeKey === key)).toBeUndefined();

    await markAlertSent(db, mine?.id as string, "ok");
    const status = await db.execute(
      sql`select status from notification_outbox where dedupe_key = ${key}`,
    );
    expect(rowsOf<{ status: string }>(status)[0]?.status).toBe("sent");
  });
});

describe("on-chain sync + reorg replay (PRD §7.1/§18)", () => {
  it("deduplicates mint logs by (chain, tx, logIndex) and replays reorg windows", async () => {
    const contract = `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`;
    const event = {
      chainId: 4663,
      txHash: `0x${randomUUID().replace(/-/g, "")}`,
      logIndex: 0,
      blockNumber: 1000n,
      blockHash: `0x${randomUUID().replace(/-/g, "")}`,
      contractAddress: contract,
      recipient: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      quantity: 1,
      finalized: false,
      observedAt: NOW,
    };
    const first = await insertMintEvents(db, [event]);
    const second = await insertMintEvents(db, [
      { ...event, blockHash: `0x${randomUUID().replace(/-/g, "")}` },
    ]);
    expect(first).toBe(1);
    expect(second).toBe(0);

    const provider = await ensureProvider(db, "robinhood_rpc");
    await saveCheckpoint(db, 4663, provider.id, { blockNumber: 1000n, blockHash: event.blockHash });
    const stored = await getCheckpoint(db, 4663, provider.id);
    expect(stored?.blockNumber).toBe(1000n);

    const unfinalized = await unfinalizeFromBlock(db, 995n);
    expect(unfinalized).toBe(1);
  });

  it("stores wallet rows uniquely by address", async () => {
    const address = `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`;
    await db.insert(wallets).values({ address }).onConflictDoNothing();
    await db.insert(wallets).values({ address }).onConflictDoNothing();
    const rows = await db.select().from(wallets);
    expect(rows.filter((w) => w.address === address)).toHaveLength(1);
  });
});

describe("whale / holder-concentration analysis (feature-backlog.md §2, 2026-08-22)", () => {
  it("refreshes and reads back a real top-10 share from seeded mint events", async () => {
    const contract = `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`;
    const whale = `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`;
    // One whale minting 40 of a 100-unit supply, split across two txs
    // (proves the SUM(quantity) GROUP BY aggregation, not just a 1-row-
    // per-wallet count), plus 12 other wallets minting 5 each (60 total).
    const events = [
      {
        chainId: 4663,
        txHash: `0x${randomUUID().replace(/-/g, "")}`,
        logIndex: 0,
        blockNumber: 2000n,
        blockHash: `0x${randomUUID().replace(/-/g, "")}`,
        contractAddress: contract,
        recipient: whale,
        quantity: 25,
        finalized: true,
        observedAt: NOW,
      },
      {
        chainId: 4663,
        txHash: `0x${randomUUID().replace(/-/g, "")}`,
        logIndex: 0,
        blockNumber: 2001n,
        blockHash: `0x${randomUUID().replace(/-/g, "")}`,
        contractAddress: contract,
        recipient: whale,
        quantity: 15, // whale's second mint — same recipient, must SUM not overwrite
        finalized: true,
        observedAt: NOW,
      },
      ...Array.from({ length: 12 }, (_, i) => ({
        chainId: 4663,
        txHash: `0x${randomUUID().replace(/-/g, "")}`,
        logIndex: 0,
        blockNumber: 2002n + BigInt(i),
        blockHash: `0x${randomUUID().replace(/-/g, "")}`,
        contractAddress: contract,
        recipient: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
        quantity: 5,
        finalized: true,
        observedAt: NOW,
      })),
    ];
    const inserted = await insertMintEvents(db, events);
    expect(inserted).toBe(14);

    const [row] = await db
      .select({ projectId: mintEvents.projectId })
      .from(mintEvents)
      .where(eq(mintEvents.txHash, events[0]?.txHash ?? ""));
    const projectId = row?.projectId;
    if (projectId === null || projectId === undefined) {
      throw new Error("project not auto-created for new contract");
    }

    // Before any refresh: no snapshot exists yet.
    expect(await getHolderConcentration(db, projectId)).toBeNull();

    await refreshHolderSnapshot(db, projectId);
    const snapshot = await getHolderConcentration(db, projectId);
    if (snapshot === null) {
      throw new Error("snapshot missing after refresh");
    }
    expect(snapshot.totalMinted).toBe(100); // 25+15+12*5
    expect(snapshot.uniqueHolders).toBe(13); // whale + 12 others
    expect(snapshot.topHolders[0]?.recipient).toBe(whale);
    expect(snapshot.topHolders[0]?.quantity).toBe(40); // 25+15 summed, not overwritten
    expect(snapshot.topHolders[0]?.sharePct).toBe(40);
    expect(snapshot.top10SharePct).toBeGreaterThan(40); // whale + 9 more @5 each = 85
    expect(snapshot.computedAt).toBeInstanceOf(Date); // plain .select(), not a raw-sql string

    // Re-running is idempotent (upsert), and reflects a since-added mint.
    await insertMintEvents(db, [
      {
        chainId: 4663,
        txHash: `0x${randomUUID().replace(/-/g, "")}`,
        logIndex: 0,
        blockNumber: 2020n,
        blockHash: `0x${randomUUID().replace(/-/g, "")}`,
        contractAddress: contract,
        recipient: whale,
        quantity: 10,
        finalized: true,
        observedAt: NOW,
      },
    ]);
    await refreshHolderSnapshot(db, projectId);
    const updated = await getHolderConcentration(db, projectId);
    expect(updated?.totalMinted).toBe(110);
    expect(updated?.topHolders[0]?.quantity).toBe(50);
  });

  it("returns null for a project with no mint events (never refreshed)", async () => {
    const created = await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      externalId: `it-no-mints-${randomUUID().slice(0, 6)}`,
      name: "No Mints Yet",
      stages: [],
      now: NOW,
    });
    expect(await getHolderConcentration(db, created.projectId)).toBeNull();
  });
});

describe("trait rarity snapshot (feature-backlog.md §2, 2026-08-22)", () => {
  it("saves and reads back a rarity snapshot, upserting on refresh", async () => {
    const created = await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      externalId: `it-rarity-${randomUUID().slice(0, 6)}`,
      name: "Rarity Test Collection",
      stages: [],
      now: NOW,
    });

    // Before any save: no snapshot exists yet.
    expect(await getRaritySnapshot(db, created.projectId)).toBeNull();

    const topRarest = [
      {
        tokenId: "1",
        rarityScore: 42.5,
        rank: 1,
        traits: [{ traitType: "Background", value: "Gold" }],
        imageUrl: "https://example.test/1.png",
      },
      {
        tokenId: "2",
        rarityScore: 10.1,
        rank: 2,
        traits: [{ traitType: "Background", value: "Blue" }],
        imageUrl: null,
      },
    ];
    await saveRaritySnapshot(db, created.projectId, { totalTokens: 100, topRarest });

    const snapshot = await getRaritySnapshot(db, created.projectId);
    if (snapshot === null) {
      throw new Error("snapshot missing after save");
    }
    expect(snapshot.totalTokens).toBe(100);
    expect(snapshot.topRarest).toEqual(topRarest); // jsonb round-trips exactly
    expect(snapshot.computedAt).toBeInstanceOf(Date); // plain .select(), not a raw-sql string

    // Re-saving is idempotent (upsert on projectId), reflecting fresh data.
    await saveRaritySnapshot(db, created.projectId, {
      totalTokens: 105,
      topRarest: [topRarest[0] as (typeof topRarest)[number]],
    });
    const updated = await getRaritySnapshot(db, created.projectId);
    expect(updated?.totalTokens).toBe(105);
    expect(updated?.topRarest).toHaveLength(1);
  });

  it("returns null for a project with no rarity snapshot yet", async () => {
    const created = await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      externalId: `it-no-rarity-${randomUUID().slice(0, 6)}`,
      name: "No Rarity Yet",
      stages: [],
      now: NOW,
    });
    expect(await getRaritySnapshot(db, created.projectId)).toBeNull();
  });
});

describe("mint execution claim — critical .rows bug fix (2026-08-22)", () => {
  it("claimArmedMintPlan actually claims an armed, due plan (was a silent permanent no-op)", async () => {
    // Found live 2026-08-22: db.execute() on this postgres-js driver
    // returns the row array directly, no `.rows` property at all
    // (Array.isArray === true, confirmed with a throwaway repro script).
    // claimArmedMintPlan's `.rows ?? []` therefore ALWAYS fell through to
    // `[]`, so this function silently returned `undefined` on every call
    // — the mint-firing pipeline could never claim a plan, ever, no
    // matter how correctly everything upstream (arm, step-up auth,
    // signer, ceiling) was configured. This test proves the fix with a
    // real armed plan against real Postgres, not a mock.
    const operatorId = `it-user-${randomUUID().slice(0, 8)}`;
    await db.insert(user).values({
      id: operatorId,
      name: "IT Operator",
      email: `${operatorId}@example.test`,
      role: "admin",
    });

    const [wallet] = await db
      .insert(wallets)
      .values({ address: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`, enabled: true })
      .returning();
    if (wallet === undefined) throw new Error("wallet insert returned no row");

    const signer = await createSigner(db, {
      chainId: 4663,
      ownerAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      scheme: "browser_wallet",
      onchainSpendCeilingWei: "1000000000000000000",
    });

    const project = await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      externalId: `it-claim-${randomUUID().slice(0, 6)}`,
      name: "Claimable Drop",
      stages: [],
      now: NOW,
    });

    const plan = await createMintPlan(db, {
      projectId: project.projectId,
      walletId: wallet.id,
      signerId: signer.id,
      perPlanCeilingWei: "100000000000000000",
    });
    expect(plan.status).toBe("draft");

    const armed = await armMintPlan(db, plan.id, operatorId, 10);
    if (armed === undefined) throw new Error("armMintPlan returned undefined");
    expect(armed.status).toBe("armed");

    const claimed = await claimArmedMintPlan(db, new Date());
    if (claimed === undefined) {
      throw new Error(
        "claimArmedMintPlan returned undefined for a real armed, in-window plan — the bug is back",
      );
    }
    expect(claimed.id).toBe(plan.id);
    expect(claimed.status).toBe("executing");
    // Every camelCase field must be populated, not undefined — proves the
    // explicit RETURNING aliases (the OTHER fix already applied to this
    // function earlier this session) still work together with this fix.
    expect(claimed.projectId).toBe(project.projectId);
    expect(claimed.walletId).toBe(wallet.id);
    expect(claimed.signerId).toBe(signer.id);
    expect(claimed.perPlanCeilingWei).toBe("100000000000000000");
    // NOT toBeInstanceOf(Date): this is a raw db.execute() result, so
    // armedAt comes back as a timestamptz string at runtime despite the
    // MintPlan type claiming Date (the sixth pass's Date-coercion finding
    // — already handled downstream via coerceDate in
    // apps/worker/src/workers/execution.ts, not a regression here).
    expect(typeof claimed.armedAt === "string" || claimed.armedAt instanceof Date).toBe(true);
    expect(Number.isNaN(new Date(claimed.armedAt as unknown as string).getTime())).toBe(false);

    // Atomic single-claim: a second call must not re-claim the same plan.
    const secondClaim = await claimArmedMintPlan(db, new Date());
    expect(secondClaim).toBeUndefined();
  });

  it("does not claim a plan whose arm window has expired", async () => {
    const operatorId = `it-user-${randomUUID().slice(0, 8)}`;
    await db.insert(user).values({
      id: operatorId,
      name: "IT Operator",
      email: `${operatorId}@example.test`,
      role: "admin",
    });
    const [wallet] = await db
      .insert(wallets)
      .values({ address: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`, enabled: true })
      .returning();
    if (wallet === undefined) throw new Error("wallet insert returned no row");
    const project = await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      externalId: `it-expired-${randomUUID().slice(0, 6)}`,
      name: "Expired Drop",
      stages: [],
      now: NOW,
    });
    const plan = await createMintPlan(db, {
      projectId: project.projectId,
      walletId: wallet.id,
      perPlanCeilingWei: "1",
    });
    // Arm with a 0-minute window, then claim slightly in the future —
    // armed_until is already in the past by the time we claim.
    await armMintPlan(db, plan.id, operatorId, 0);
    const claimed = await claimArmedMintPlan(db, new Date(Date.now() + 1000));
    expect(claimed).toBeUndefined();
  });
});

describe("speculative pre-build cache (ADR 0009, item P4, 2026-08-22)", () => {
  it("plansNeedingPreBuild finds an armed plan with no cache, and stops finding it once cached", async () => {
    const operatorId = `it-user-${randomUUID().slice(0, 8)}`;
    await db.insert(user).values({
      id: operatorId,
      name: "IT Operator",
      email: `${operatorId}@example.test`,
      role: "admin",
    });
    const [wallet] = await db
      .insert(wallets)
      .values({ address: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`, enabled: true })
      .returning();
    if (wallet === undefined) throw new Error("wallet insert returned no row");
    const project = await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      externalId: `it-prebuild-${randomUUID().slice(0, 6)}`,
      name: "Pre-build Target",
      stages: [],
      now: NOW,
    });
    const plan = await createMintPlan(db, {
      projectId: project.projectId,
      walletId: wallet.id,
      perPlanCeilingWei: "1",
    });
    await armMintPlan(db, plan.id, operatorId, 10);

    const before = await plansNeedingPreBuild(db, new Date(), 5 * 60 * 1000);
    expect(before.some((p) => p.id === plan.id)).toBe(true);

    await cacheMintPlanTx(db, plan.id, {
      to: "0xtarget",
      data: "0xdeadbeef",
      valueWei: "0",
      chainId: 4663,
    });

    const after = await plansNeedingPreBuild(db, new Date(), 5 * 60 * 1000);
    expect(after.some((p) => p.id === plan.id)).toBe(false);
  });

  it("claimArmedMintPlan returns cachedTx/cachedTxAt — the exact RETURNING-list bug this session already found twice, checked a third time", async () => {
    // This is a real regression guard: adding a column to mint_plans
    // without adding it to claimArmedMintPlan's raw-SQL RETURNING list is
    // a silent bug (the field is just always undefined), not a type
    // error — see the comment on claimArmedMintPlan itself for the first
    // two times this exact function bit this session.
    const operatorId = `it-user-${randomUUID().slice(0, 8)}`;
    await db.insert(user).values({
      id: operatorId,
      name: "IT Operator",
      email: `${operatorId}@example.test`,
      role: "admin",
    });
    const [wallet] = await db
      .insert(wallets)
      .values({ address: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`, enabled: true })
      .returning();
    if (wallet === undefined) throw new Error("wallet insert returned no row");
    const project = await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      externalId: `it-prebuild-claim-${randomUUID().slice(0, 6)}`,
      name: "Pre-build Claim Target",
      stages: [],
      now: NOW,
    });
    const plan = await createMintPlan(db, {
      projectId: project.projectId,
      walletId: wallet.id,
      perPlanCeilingWei: "1",
    });
    await armMintPlan(db, plan.id, operatorId, 10);
    await cacheMintPlanTx(db, plan.id, {
      to: "0xtarget",
      data: "0xdeadbeef",
      valueWei: "0",
      chainId: 4663,
    });

    const claimed = await claimArmedMintPlan(db, new Date());
    if (claimed === undefined) throw new Error("claimArmedMintPlan returned undefined");
    expect(claimed.cachedTx).toEqual({
      to: "0xtarget",
      data: "0xdeadbeef",
      valueWei: "0",
      chainId: 4663,
    });
    expect(claimed.cachedTxAt).not.toBeNull();
    // Same Date-coercion caveat as armedAt in the earlier claim test:
    // this is a string at runtime via the raw-SQL RETURNING path, not a
    // real Date, despite the schema type.
    expect(Number.isNaN(new Date(claimed.cachedTxAt as unknown as string).getTime())).toBe(false);
  });
});

describe("mint plan lease state machine (code review finding #1, 2026-08-23)", () => {
  // These tests exercise the GLOBAL claimArmedMintPlan (claims the oldest
  // due plan system-wide), and the suite shares one DB with no per-test
  // cleanup — so isolate by cancelling every pre-existing plan first, making
  // the one plan each test arms the only claimable one.
  beforeEach(async () => {
    await db.update(mintPlans).set({ status: "cancelled" });
  });

  async function armedPlan(windowMinutes: number): Promise<string> {
    const operatorId = `it-user-${randomUUID().slice(0, 8)}`;
    await db.insert(user).values({
      id: operatorId,
      name: "IT Operator",
      email: `${operatorId}@example.test`,
      role: "admin",
    });
    const [wallet] = await db
      .insert(wallets)
      .values({ address: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`, enabled: true })
      .returning();
    if (wallet === undefined) throw new Error("wallet insert returned no row");
    const project = await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      externalId: `it-lease-${randomUUID().slice(0, 6)}`,
      name: "Lease Drop",
      stages: [],
      now: NOW,
    });
    const plan = await createMintPlan(db, {
      projectId: project.projectId,
      walletId: wallet.id,
      perPlanCeilingWei: "100000000000000000",
    });
    const armed = await armMintPlan(db, plan.id, operatorId, windowMinutes);
    if (armed === undefined) throw new Error("armMintPlan returned undefined");
    return plan.id;
  }

  async function statusOf(id: string): Promise<string> {
    const [row] = await db
      .select({ status: mintPlans.status })
      .from(mintPlans)
      .where(eq(mintPlans.id, id));
    return row?.status ?? "MISSING";
  }

  it("release-to-armed makes a claimed plan re-claimable — the continuous-compete loop, and the fix for the shadow-mode dead-arm bug", async () => {
    const planId = await armedPlan(10);

    const first = await claimArmedMintPlan(db, new Date());
    expect(first?.id).toBe(planId);
    expect(await statusOf(planId)).toBe("executing");

    // Before release, it is NOT re-claimable (still leased/executing).
    expect(await claimArmedMintPlan(db, new Date())).toBeUndefined();

    // A non-terminal outcome releases it back to armed...
    await releaseMintPlanToArmed(db, planId, new Date());
    expect(await statusOf(planId)).toBe("armed");
    // ...and now the next tick re-claims it — without this, a single shadow
    // pass or too-early simulation revert would strand the plan forever.
    const second = await claimArmedMintPlan(db, new Date());
    expect(second?.id).toBe(planId);
  });

  it("a stale executing lease is reclaimed after the lease elapses (crash recovery), not before", async () => {
    const planId = await armedPlan(10);
    expect((await claimArmedMintPlan(db, new Date()))?.id).toBe(planId);

    // Worker crashed between claim and release: no release happens. A claim
    // still inside the 15s lease must NOT reclaim it...
    expect(await claimArmedMintPlan(db, new Date())).toBeUndefined();
    // ...but once the lease has elapsed it is reclaimable so the mint isn't
    // lost (pass a 'now' beyond the default 15s lease).
    const afterLease = await claimArmedMintPlan(db, new Date(Date.now() + 20_000));
    expect(afterLease?.id).toBe(planId);
  });

  it("markMintPlanExecuted is terminal — an executed plan is never re-claimed", async () => {
    const planId = await armedPlan(10);
    await claimArmedMintPlan(db, new Date());
    await markMintPlanExecuted(db, planId);
    expect(await statusOf(planId)).toBe("executed");
    expect(await claimArmedMintPlan(db, new Date(Date.now() + 60_000))).toBeUndefined();
  });

  it("failMintPlanExecution is terminal — a failed plan is never re-claimed", async () => {
    const planId = await armedPlan(10);
    await claimArmedMintPlan(db, new Date());
    await failMintPlanExecution(db, planId);
    expect(await statusOf(planId)).toBe("failed");
    expect(await claimArmedMintPlan(db, new Date(Date.now() + 60_000))).toBeUndefined();
  });

  it("expireStaleMintPlans sweeps a stuck 'executing' plan past its window, not just 'armed'", async () => {
    const planId = await armedPlan(10);
    // Claim flips it to executing; nobody releases it (worker died).
    expect((await claimArmedMintPlan(db, new Date()))?.id).toBe(planId);
    expect(await statusOf(planId)).toBe("executing");

    // Sweep with a 'now' past the 10-min window: the stuck executing plan
    // must be expired (the old code only swept 'armed', stranding this).
    const swept = await expireStaleMintPlans(db, new Date(Date.now() + 11 * 60_000));
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await statusOf(planId)).toBe("expired");
  });

  it("armedPlansWithStageStart returns stage-linked armed plans (hot-loop candidates) and their stage start, excluding stage-less plans", async () => {
    const stageless = await armedPlan(10); // helper makes a stage-less plan

    const operatorId = `it-user-${randomUUID().slice(0, 8)}`;
    await db.insert(user).values({
      id: operatorId,
      name: "IT Operator",
      email: `${operatorId}@example.test`,
      role: "admin",
    });
    const [wallet] = await db
      .insert(wallets)
      .values({ address: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`, enabled: true })
      .returning();
    if (wallet === undefined) throw new Error("wallet insert returned no row");
    const start = new Date(NOW.getTime() + 60_000);
    const project = await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      externalId: `it-hotloop-${randomUUID().slice(0, 6)}`,
      name: "HotLoop Drop",
      stages: [
        {
          providerStageId: "s1",
          label: "Public",
          kind: "public",
          priceWei: "0",
          currency: null,
          maxPerWallet: 1,
          startsAt: start,
          endsAt: new Date(NOW.getTime() + 2 * 60_000),
          paused: false,
        },
      ],
      now: NOW,
    });
    const [stage] = await db
      .select({ id: dropStages.id })
      .from(dropStages)
      .where(eq(dropStages.projectId, project.projectId));
    if (stage === undefined) throw new Error("stage not created");
    const plan = await createMintPlan(db, {
      projectId: project.projectId,
      walletId: wallet.id,
      stageId: stage.id,
      perPlanCeilingWei: "1",
    });
    await armMintPlan(db, plan.id, operatorId, 10);

    const candidates = await armedPlansWithStageStart(db, new Date());
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain(plan.id);
    expect(ids).not.toContain(stageless); // stage-less plan is not a hot-loop candidate
    expect(candidates.find((c) => c.id === plan.id)?.stageStartMs).toBe(start.getTime());
  });
});

describe("projectIdsForContracts (code review finding #2, 2026-08-23)", () => {
  it("resolves multiple contracts in one parameterized query (the raw-SQL join matched zero)", async () => {
    const c1 = `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`;
    const c2 = `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`;
    const p1 = await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: c1,
      externalId: `it-pidc1-${randomUUID().slice(0, 6)}`,
      name: "PIDC One",
      stages: [],
      now: NOW,
    });
    const p2 = await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: c2,
      externalId: `it-pidc2-${randomUUID().slice(0, 6)}`,
      name: "PIDC Two",
      stages: [],
      now: NOW,
    });
    // Mixed case input must still match (schema stores lowercase canonical).
    const ids = await projectIdsForContracts(db, [c1.toUpperCase(), c2, "0xdeadbeef"]);
    expect(new Set(ids)).toEqual(new Set([p1.projectId, p2.projectId]));
  });

  it("returns empty for no contracts without hitting the DB with a malformed array", async () => {
    expect(await projectIdsForContracts(db, [])).toEqual([]);
  });
});

describe("sentiment/risk signals repository (ADR 0007, 2026-08-23)", () => {
  it("insertSignal + latestSignal round-trips the rolling-baseline evidence", async () => {
    const project = await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      externalId: `it-sig-${randomUUID().slice(0, 6)}`,
      name: "Signal Drop",
      stages: [],
      now: NOW,
    });
    const subject = `sig-subject-${randomUUID().slice(0, 8)}`;
    await insertSignal(db, {
      projectId: project.projectId,
      subject,
      source: "x_mentions",
      kind: "hype",
      score: 40,
      confidence: "single-source",
      evidence: { tweetCount: 12, newestId: "111" },
      observedAt: new Date(NOW.getTime() - 60_000),
    });
    await insertSignal(db, {
      projectId: project.projectId,
      subject,
      source: "x_mentions",
      kind: "hype",
      score: 80,
      confidence: "single-source",
      evidence: { tweetCount: 30, newestId: "222" },
      observedAt: NOW,
    });

    const latest = await latestSignal(db, subject, "x_mentions", "hype");
    expect(latest?.score).toBe(80);
    expect(latest?.evidence?.tweetCount).toBe(30); // baseline the worker reads next pass
    expect(latest?.evidence?.newestId).toBe("222"); // since_id for the next scan
  });

  it("latestSignalsForProject returns the newest hype and risk separately", async () => {
    const project = await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      externalId: `it-sig2-${randomUUID().slice(0, 6)}`,
      name: "Signal Drop Two",
      stages: [],
      now: NOW,
    });
    await insertSignal(db, {
      projectId: project.projectId,
      subject: "s2",
      source: "x_mentions",
      kind: "hype",
      score: 55,
      confidence: "single-source",
      observedAt: NOW,
    });
    await insertSignal(db, {
      projectId: project.projectId,
      subject: "s2",
      source: "x_mentions",
      kind: "risk",
      score: 70,
      confidence: "single-source",
      evidence: { flags: ["connect wallet"] },
      observedAt: NOW,
    });
    const latest = await latestSignalsForProject(db, project.projectId);
    expect(latest.hype?.score).toBe(55);
    expect(latest.risk?.score).toBe(70);
    expect(latest.risk?.evidence?.flags).toEqual(["connect wallet"]);
  });

  it("projectsForSentimentScan returns only LIVE/NEXT projects, bounded", async () => {
    // A LIVE project (has an in-window public stage → computeLifecycle LIVE).
    const liveSlug = `it-live-sig-${randomUUID().slice(0, 6)}`;
    await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      externalId: liveSlug,
      slug: liveSlug,
      name: "Live For Sentiment",
      stages: [
        {
          providerStageId: "pub",
          label: "Public",
          kind: "public",
          priceWei: "0",
          currency: null,
          maxPerWallet: 3,
          startsAt: new Date(NOW.getTime() - H),
          endsAt: new Date(NOW.getTime() + H),
          paused: false,
        },
      ],
      now: NOW,
    });
    const candidates = await projectsForSentimentScan(db, 5);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates.length).toBeLessThanOrEqual(5);
    // Every returned project carries the name/slug the worker queries X by.
    for (const c of candidates) {
      expect(typeof c.name).toBe("string");
    }
  });
});

describe("multi-network RPC chain discovery (2026-08-23)", () => {
  it("distinctEnabledRpcChainIds returns only chains with an enabled endpoint", async () => {
    // Two chains with enabled endpoints, one with an endpoint we disable.
    await createRpcEndpoint(db, {
      chainId: 8453,
      label: "base-1",
      httpUrl: "https://base.example",
    });
    await createRpcEndpoint(db, {
      chainId: 42161,
      label: "arb-1",
      httpUrl: "https://arb.example",
    });
    const disabled = await createRpcEndpoint(db, {
      chainId: 10,
      label: "op-1",
      httpUrl: "https://op.example",
    });
    // createRpcEndpoint defaults enabled=true; disable the op one.
    const { setRpcEndpointEnabled } = await import("../src/index.ts");
    await setRpcEndpointEnabled(db, disabled.id, false);

    const chainIds = await distinctEnabledRpcChainIds(db);
    expect(chainIds).toContain(8453);
    expect(chainIds).toContain(42161);
    expect(chainIds).not.toContain(10); // disabled → excluded from the sync set
  });
});

describe("managed minting-key hygiene (custody review, 2026-08-28)", () => {
  const RAW_TX = "0x02f8deadbeef";
  const LEGACY = JSON.stringify({ ciphertext: "AAAA", keyVersion: 1, algorithm: "aes-256-gcm" });
  const ENVELOPE = JSON.stringify({
    ciphertext: "BBBB",
    keyVersion: 1,
    algorithm: "x25519-hkdf-sha256-aes-256-gcm",
  });

  async function managedWalletWithArmedPlan() {
    const operatorId = `it-user-${randomUUID().slice(0, 8)}`;
    await db.insert(user).values({
      id: operatorId,
      name: "IT Operator",
      email: `${operatorId}@example.test`,
      role: "admin",
    });
    const address = `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`;
    const [wallet] = await db.insert(wallets).values({ address, enabled: true }).returning();
    if (wallet === undefined) throw new Error("wallet insert returned no row");
    expect(await setWalletSigningKey(db, wallet.id, LEGACY, "fp0123456789")).toBe(true);
    const signer = await createSigner(db, {
      chainId: 4663,
      ownerAddress: address,
      scheme: "browser_wallet",
      onchainSpendCeilingWei: "1000000000000000000",
    });
    const project = await upsertProjectFromSource(db, {
      ...baseProject,
      contractAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      externalId: `it-hyg-${randomUUID().slice(0, 6)}`,
      name: "Hygiene Drop",
      stages: [],
      now: NOW,
    });
    const plan = await createMintPlan(db, {
      projectId: project.projectId,
      walletId: wallet.id,
      signerId: signer.id,
      perPlanCeilingWei: "100000000000000000",
    });
    const armed = await armMintPlan(db, plan.id, operatorId, 10);
    if (armed === undefined) throw new Error("armMintPlan returned undefined");
    await savePresignedTx(db, plan.id, { rawTx: RAW_TX, nonce: 7, txHash: `0x${"11".repeat(32)}` });
    return { wallet, plan, operatorId, address };
  }

  async function presignOf(planId: string) {
    const [row] = await db
      .select({
        raw: mintPlans.presignedRawTx,
        nonce: mintPlans.presignedNonce,
        status: mintPlans.status,
      })
      .from(mintPlans)
      .where(eq(mintPlans.id, planId));
    return row;
  }

  it("disarm purges the pre-signed (spend-capable) blob — finding #1", async () => {
    const { plan } = await managedWalletWithArmedPlan();
    expect((await presignOf(plan.id))?.raw).toBe(RAW_TX);
    await disarmMintPlan(db, plan.id);
    const after = await presignOf(plan.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.raw).toBeNull();
    expect(after?.nonce).toBeNull();
  });

  it("expiry purges the pre-signed blob — finding #1", async () => {
    const { plan } = await managedWalletWithArmedPlan();
    await db
      .update(mintPlans)
      .set({ armedUntil: new Date(Date.now() - 60_000) })
      .where(eq(mintPlans.id, plan.id));
    expect(await expireStaleMintPlans(db, new Date())).toBeGreaterThanOrEqual(1);
    const after = await presignOf(plan.id);
    expect(after?.status).toBe("expired");
    expect(after?.raw).toBeNull();
  });

  it("executed / failed terminal transitions purge the blob too", async () => {
    // Put each plan straight into `executing` (the state both terminal
    // transitions require) rather than racing claimArmedMintPlan against
    // armed plans left over from earlier cases.
    const a = await managedWalletWithArmedPlan();
    await db.update(mintPlans).set({ status: "executing" }).where(eq(mintPlans.id, a.plan.id));
    await markMintPlanExecuted(db, a.plan.id);
    expect((await presignOf(a.plan.id))?.status).toBe("executed");
    expect((await presignOf(a.plan.id))?.raw).toBeNull();

    const b = await managedWalletWithArmedPlan();
    await db.update(mintPlans).set({ status: "executing" }).where(eq(mintPlans.id, b.plan.id));
    await failMintPlanExecution(db, b.plan.id);
    expect((await presignOf(b.plan.id))?.status).toBe("failed");
    expect((await presignOf(b.plan.id))?.raw).toBeNull();
  });

  it("revoke leaves no key-derived trace: blob, fingerprint, presign, audit metadata", async () => {
    const { wallet, plan, operatorId, address } = await managedWalletWithArmedPlan();
    await recordAudit(db, {
      actorUserId: operatorId,
      action: "wallet.key_import",
      targetType: "wallet",
      targetId: address,
      result: "success",
      metadata: { address, fingerprint: "fp0123456789" },
    });
    expect(await getWalletSigningKeySealed(db, wallet.id)).toBe(LEGACY);

    expect(await clearWalletSigningKey(db, wallet.id)).toBe(true);
    expect(await clearPresignedForWallet(db, wallet.id)).toBe(1);
    expect(await scrubKeyTracesForAddress(db, address)).toBe(1);

    const [w] = await db.select().from(wallets).where(eq(wallets.id, wallet.id));
    expect(w?.encryptedSigningKey).toBeNull();
    expect(w?.signingKeyFingerprint).toBeNull();
    expect(w?.signingKeyAddedAt).toBeNull();
    expect((await presignOf(plan.id))?.raw).toBeNull();
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.targetId, address));
    expect(audit?.metadata).toEqual({ address, key_scrubbed: true });
    expect(JSON.stringify(audit?.metadata)).not.toContain("fp0123456789");
    // Dead-tuple reclaim runs on the pool outside any transaction.
    expect(await vacuumKeyTables(db)).toEqual({ ok: true });
  });

  it("delete cancels open plans, purges presign, and the row (with ciphertext) is gone", async () => {
    const { wallet, plan } = await managedWalletWithArmedPlan();
    expect(await clearPresignedForWallet(db, wallet.id)).toBe(1);
    expect(await cancelOpenPlansForWallet(db, wallet.id)).toBe(1);
    const before = await presignOf(plan.id);
    expect(before?.status).toBe("cancelled");
    expect(before?.raw).toBeNull();
    await db.delete(wallets).where(eq(wallets.id, wallet.id));
    // Whatever the FK does with the plan row (cascade or set-null), it must
    // not still carry a blob.
    const after = await presignOf(plan.id);
    expect(after?.raw ?? null).toBeNull();
    const [gone] = await db.select().from(wallets).where(eq(wallets.id, wallet.id));
    expect(gone).toBeUndefined();
    // Nothing anywhere still carries the ciphertext text.
    const leak = await db.execute(
      sql`select count(*)::int as n from mint_plans where presigned_raw_tx is not null`,
    );
    expect(unwrap<{ n: number }>(leak)[0]?.n).toBe(0);
  });

  it("legacy → envelope re-seal is compare-and-swap so a concurrent revoke wins", async () => {
    const { wallet } = await managedWalletWithArmedPlan();
    const legacyRows = await walletsWithLegacySealedKey(db);
    expect(legacyRows.map((r) => r.id)).toContain(wallet.id);
    expect(await resealWalletSigningKey(db, wallet.id, LEGACY, ENVELOPE)).toBe(true);
    expect(await getWalletSigningKeySealed(db, wallet.id)).toBe(ENVELOPE);
    expect((await walletsWithLegacySealedKey(db)).map((r) => r.id)).not.toContain(wallet.id);
    // Stale expected value (already revoked / already re-sealed) → no write.
    await clearWalletSigningKey(db, wallet.id);
    expect(await resealWalletSigningKey(db, wallet.id, LEGACY, ENVELOPE)).toBe(false);
    expect(await getWalletSigningKeySealed(db, wallet.id)).toBeUndefined();
  });
});

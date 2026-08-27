/**
 * Deterministic demo seed (PRD §19):
 *  - one live public drop
 *  - one upcoming signed presale with an eligible wallet
 *  - one ineligible signed presale
 *  - one public-only result
 *  - one sold-out drop
 *  - one stale provider (health = degraded, old last_success)
 *  - one conflicting-source record (project_fields isWinner=false)
 *  - one alert retry (outbox pending with attempts>0)
 * Sets demo_mode so the persistent DEMO DATA banner shows (visually identical
 * to live mode otherwise).
 */

import { loadEnv } from "@hoodmint/config";
import {
  createDb,
  createWallet,
  dbClient,
  enqueueAlert,
  ensureProvider,
  markProviderHealth,
  setSetting,
  upsertEligibilityCheck,
  upsertProjectFromSource,
} from "@hoodmint/db";
import { sql } from "drizzle-orm";

const NOW = new Date();
const H = 3600_000;
/** Obviously-synthetic fixture address, matching the demo contracts below. */
const DEMO_WALLET_ADDRESS = "0x6666666666666666666666666666666666666666";

async function main(): Promise<void> {
  const config = loadEnv();
  const db = createDb(config.DATABASE_URL, { max: 1 });
  const opensea = await ensureProvider(db, "opensea");
  void opensea;

  await seedProject(db, {
    slug: "demo-live-public",
    name: "Hood Birds (LIVE public)",
    contract: "0x1111111111111111111111111111111111111111",
    stages: [
      {
        providerStageId: "demo-live-public:public",
        label: "Public Mint",
        kind: "public",
        priceWei: "0",
        startsAt: new Date(NOW.getTime() - 1 * H),
        endsAt: new Date(NOW.getTime() + 5 * H),
      },
    ],
    supply: { minted: 1234n, maxSupply: 5000n, verified: true, source: "demo" },
    mintEvents: 40,
  });

  const eligibleSlug = "demo-upcoming-eligible";
  await seedProject(db, {
    slug: eligibleSlug,
    name: "Robindroids WL (eligible presale)",
    contract: "0x2222222222222222222222222222222222222222",
    stages: [
      {
        providerStageId: "demo-eligible:wl",
        label: "Allowlist Mint",
        kind: "allowlist",
        priceWei: "4200000000000000",
        startsAt: new Date(NOW.getTime() + 6 * H),
        endsAt: new Date(NOW.getTime() + 8 * H),
      },
      {
        providerStageId: "demo-eligible:public",
        label: "Public Mint",
        kind: "public",
        priceWei: "6900000000000000",
        startsAt: new Date(NOW.getTime() + 8 * H),
        endsAt: new Date(NOW.getTime() + 10 * H),
      },
    ],
    supply: null,
    mintEvents: 0,
  });

  await seedProject(db, {
    slug: "demo-upcoming-ineligible",
    name: "Gated Guild Presale (NOT WL)",
    contract: "0x3333333333333333333333333333333333333333",
    stages: [
      {
        providerStageId: "demo-ineligible:wl",
        label: "Guild Allowlist",
        kind: "allowlist",
        priceWei: "10000000000000000",
        startsAt: new Date(NOW.getTime() + 20 * H),
        endsAt: new Date(NOW.getTime() + 22 * H),
      },
    ],
    supply: null,
    mintEvents: 0,
  });

  await seedProject(db, {
    slug: "demo-public-only",
    name: "Open Festival Pass",
    contract: "0x4444444444444444444444444444444444444444",
    stages: [
      {
        providerStageId: "demo-public-only:public",
        label: "Free For All",
        kind: "public",
        priceWei: "0",
        startsAt: new Date(NOW.getTime() + 2 * H),
        endsAt: new Date(NOW.getTime() + 6 * H),
      },
    ],
    supply: null,
    mintEvents: 5,
  });

  await seedProject(db, {
    slug: "demo-soldout",
    name: "Genesis Capsules (SOLD OUT)",
    contract: "0x5555555555555555555555555555555555555555",
    stages: [
      {
        providerStageId: "demo-soldout:wl",
        label: "Allowlist Mint",
        kind: "allowlist",
        priceWei: "0",
        startsAt: new Date(NOW.getTime() - 48 * H),
        endsAt: new Date(NOW.getTime() - 40 * H),
      },
    ],
    supply: { minted: 10000n, maxSupply: 10000n, verified: true, source: "demo" },
    mintEvents: 0,
  });

  // Wallets + eligibility rows (PRD §19 scenarios 2–4).
  // Synthetic demo wallet, in the same 0x…-repeated style as the demo
  // contracts above. This is fixture data for DEMO_MODE only — the app has no
  // default tracked wallet; real ones are added in Admin → Wallets.
  const wallet = await createWallet(db, {
    address: config.DEFAULT_WALLET_ADDRESS ?? DEMO_WALLET_ADDRESS,
    label: "demo degen",
  });
  if (wallet !== undefined) {
    const stages = await db.execute(
      sql`select id, provider_stage_id, project_id from drop_stages where project_id in (select id from projects where slug in (${eligibleSlug}, 'demo-upcoming-ineligible', 'demo-public-only'))`,
    );
    const rows =
      (
        stages as unknown as {
          rows?: { id: string; provider_stage_id: string; project_id: string }[];
        }
      ).rows ?? [];
    for (const stage of rows) {
      const status = stage.provider_stage_id.includes(":wl")
        ? stage.provider_stage_id.startsWith("demo-eligible")
          ? "ELIGIBLE_RESTRICTED"
          : "INELIGIBLE_RESTRICTED"
        : "PUBLIC_ONLY";
      await upsertEligibilityCheck(db, {
        walletId: wallet.id,
        projectId: stage.project_id,
        stageId: stage.id,
        status,
        checkedAt: NOW,
        nextDueAt: new Date(NOW.getTime() + 30 * 60_000),
      });
    }

    // One alert retry in flight (attempts>0, still pending).
    const eligibleProject = await db.execute(
      sql`select id from projects where slug = ${eligibleSlug} limit 1`,
    );
    const projectId = ((eligibleProject as unknown as { rows?: { id: string }[] }).rows ?? [])[0]
      ?.id;
    if (projectId !== undefined) {
      await enqueueAlert(db, {
        dedupeKey: "demo:retry:1",
        alertType: "restricted_eligible",
        walletId: wallet.id,
        projectId,
        thresholdMinutes: 0,
        payload: {
          text: "DEMO — WL HIT: Robindroids WL (eligible presale)\nStage: Allowlist Mint | retrying delivery",
        },
      });
      await db.execute(sql`update notification_outbox set attempts = 2, status = 'pending',
        last_error_code = 'timeout' where dedupe_key = 'demo:retry:1'`);
    }
  }

  // Stale provider: old success + degraded (PRD §19 scenario 6).
  await markProviderHealth(db, "opensea", "degraded");
  await db.execute(
    sql`update providers set last_success_at = now() - interval '4 hours' where kind = 'opensea'`,
  );

  // Conflicting-source record (scenario 7): losing claim on stage label.
  await db.execute(sql`
    insert into project_fields (id, project_id, field, value_json, provider_id, observed_at, is_winner)
    select uuidv7(), p.id, 'stageLabel', '{"value": "VIP Early Access", "provider": "calendar"}'::jsonb,
           (select id from providers where kind = 'opensea'), now(), false
      from projects p where p.slug = ${eligibleSlug}
  `);

  await setSetting(db, "demo_mode", true);
  console.log("seeded demo dataset (8 PRD §19 scenarios) and enabled demo_mode");
  await dbClient(db).end({ timeout: 5 });
}

async function seedProject(
  db: ReturnType<typeof createDb>,
  input: {
    slug: string;
    name: string;
    contract: string;
    stages: {
      providerStageId: string;
      label: string;
      kind: "public" | "allowlist" | "presale" | "gtd" | "community" | "unknown";
      priceWei: string | null;
      startsAt: Date;
      endsAt: Date;
    }[];
    supply: { minted: bigint; maxSupply: bigint; verified: boolean; source: string } | null;
    mintEvents: number;
  },
): Promise<void> {
  const result = await upsertProjectFromSource(db, {
    providerKind: "opensea",
    externalId: input.slug,
    chainId: 4663,
    contractAddress: input.contract,
    name: input.name,
    slug: input.slug,
    imageUrl: null,
    confidence: input.supply?.verified === true ? "verified" : "single-source",
    stages: input.stages.map((stage) => ({
      providerStageId: stage.providerStageId,
      label: stage.label,
      kind: stage.kind,
      priceWei: stage.priceWei,
      currency: null,
      maxPerWallet: 2,
      startsAt: stage.startsAt,
      endsAt: stage.endsAt,
      paused: false,
    })),
    supply: input.supply,
    evidence: {
      kind: "demo:seed",
      fetchedAt: NOW,
      contentHash: `demo-${input.slug}`,
      sanitizedPayload: { seeded: true, slug: input.slug },
    },
    now: NOW,
  });

  if (input.mintEvents > 0) {
    const values = Array.from({ length: input.mintEvents }, (_, i) => {
      const recipient = `0x${(0x1000000000000000000000000000000000000000n + BigInt(i * 7)).toString(16).padStart(40, "0")}`;
      const txHash = `0x${(0xa00000000000000000000000000000000000000000000000000000000000000n + BigInt(i)).toString(16).padStart(64, "0")}`;
      return sql`(${4663}, ${txHash}, ${i}, ${900000n + BigInt(i)}, ${`0x${(0xb00000000000000000000000000000000000000000000000000000000000000n + BigInt(i)).toString(16).padStart(64, "0")}`}, ${result.projectId}::uuid, ${recipient}, 1, true, now() - interval '30 minutes')`;
    });
    await db.execute(sql`
      insert into mint_events (chain_id, tx_hash, log_index, block_number, block_hash, project_id, recipient, quantity, finalized, observed_at)
      values ${sql.join(values, sql`, `)}
      on conflict do nothing
    `);
    await db.execute(sql`
      insert into mint_aggregates (project_id, bucket_start, bucket_size, quantity, unique_recipients)
      values (${result.projectId}::uuid, date_trunc('hour', now() - interval '30 minutes'), '5m', ${input.mintEvents}, ${input.mintEvents})
      on conflict (project_id, bucket_start, bucket_size) do update set quantity = excluded.quantity
    `);
    await db.execute(sql`
      insert into supply_snapshots (id, project_id, minted, max_supply, observed_at, source, verified)
      values (uuidv7(), ${result.projectId}::uuid, ${BigInt(input.mintEvents)}, null, now(), 'on-chain', false)
    `);
  }
}

main().catch((error: unknown) => {
  console.error("seed failed:", error);
  process.exit(1);
});

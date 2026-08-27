/**
 * HoodMint Radar worker entrypoint (PRD §8.3/§8.4).
 *
 * - Discovery runs on a BullMQ repeatable schedule with deterministic job
 *   ids; detail refreshes ride the details queue with freshness buckets.
 * - Eligibility, chain sync, notifications, and maintenance run as bounded
 *   interval loops that are idempotent (DB constraints are the final defense
 *   under at-least-once semantics).
 * - A tiny HTTP server exposes /health/live for compose health checks.
 */
import http from "node:http";
import { dbClient } from "@hoodmint/db";
import { dispatchDueAlerts } from "@hoodmint/notifications";
import { metrics } from "@hoodmint/observability";
import { QUEUE_NAMES } from "@hoodmint/queues";
import { Worker } from "bullmq";
import { context } from "./context.ts";
import { runChainSync } from "./workers/chain.ts";
import { runClockCalibration } from "./workers/clock-calibration.ts";
import { runDetailRefresh, runDiscoveryCycle } from "./workers/discovery.ts";
import { ensureEligibilityRows, runEligibilityPass } from "./workers/eligibility.ts";
import { runMintExecutionPass, runMintHotLoop } from "./workers/execution.ts";
import { refreshProviderFreshness, runMaintenance } from "./workers/maintenance.ts";
import { runSpeculativePreBuild } from "./workers/pre-build.ts";
import { runRarityRefresh } from "./workers/rarity.ts";
import { runRpcHealthCheck } from "./workers/rpc-health.ts";
import { runSentimentScan } from "./workers/sentiment.ts";

const ctx = context();
const { config, log, db } = ctx;

const timers: ReturnType<typeof setInterval>[] = [];
const workers: Worker[] = [];

function every(ms: number, name: string, fn: () => Promise<unknown>): void {
  const run = (): void => {
    fn().catch((error: unknown) => {
      log.error({ err: error, job: name }, "interval task failed");
    });
  };
  run();
  timers.push(setInterval(run, ms));
}

async function main(): Promise<void> {
  log.info(
    { chainId: config.ROBINHOOD_CHAIN_ID, discoveryInterval: config.DISCOVERY_INTERVAL_SECONDS },
    "worker starting",
  );

  const connection = {
    host: new URL(config.VALKEY_URL).hostname,
    port: Number.parseInt(new URL(config.VALKEY_URL).port || "6379", 10),
  };

  // ── Discovery + details workers (BullMQ, deterministic job ids) ──────────
  const discoveryWorker = new Worker(
    QUEUE_NAMES.discovery,
    async (job) => {
      const data = job.data as { dropType: "featured" | "upcoming" | "recently_minted" };
      return runDiscoveryCycle(ctx, data.dropType);
    },
    { connection, concurrency: 1 },
  );
  const detailsWorker = new Worker(
    QUEUE_NAMES.details,
    async (job) => {
      const data = job.data as { slug: string };
      return runDetailRefresh(ctx, data.slug);
    },
    { connection, concurrency: 2 },
  );
  // Admin-triggered, not scheduled (feature-backlog.md §2) — one project at
  // a time is plenty since a human clicked "Refresh" and is watching for it.
  const rarityWorker = new Worker(
    QUEUE_NAMES.rarity,
    async (job) => {
      const data = job.data as { projectId: string };
      return runRarityRefresh(ctx, data.projectId);
    },
    { connection, concurrency: 1 },
  );
  workers.push(discoveryWorker, detailsWorker, rarityWorker);

  discoveryWorker.on("failed", (job, error) => {
    metrics().inc("hoodmint_jobs_retries_total", { queue: QUEUE_NAMES.discovery });
    log.warn({ jobId: job?.id, err: error.message }, "discovery job failed");
  });
  rarityWorker.on("failed", (job, error) => {
    metrics().inc("hoodmint_jobs_retries_total", { queue: QUEUE_NAMES.rarity });
    log.warn({ jobId: job?.id, err: error.message }, "rarity job failed");
  });

  // ── Discovery scheduler: repeatable job per feed type ─────────────────────
  const { Queue } = await import("bullmq");
  for (const _feedType of ["featured", "upcoming", "recently_minted"] as const) {
    const queue = new Queue(QUEUE_NAMES.discovery, { connection });

    await queue.close();
  }

  // ── Interval loops (idempotent) ───────────────────────────────────────────
  every(60_000, "eligibility", async () => {
    await ensureEligibilityRows(ctx);
    await runEligibilityPass(ctx);
  });
  every(config.CHAIN_SYNC_INTERVAL_SECONDS * 1000, "chain-sync", () => runChainSync(ctx));
  // ADR 0009 (mint-race competitiveness), item P2: the admin-configurable
  // RPC registry existed but nothing ever recorded health against it —
  // this is what makes rankRpcEndpoints() have real data to rank on.
  every(45_000, "rpc-health", () => runRpcHealthCheck(ctx));
  // ADR 0009, item P5: same cadence as rpc-health since it reuses the
  // same best-endpoint resolution.
  every(45_000, "clock-calibration", () => runClockCalibration(ctx));
  every(10_000, "notifications", () =>
    dispatchDueAlerts({
      db,
      masterKey: config.APP_ENCRYPTION_KEY,
      claimLimit: 20,
      // Opt-in (feature-backlog.md's Web Push, shipped 2026-08-22): only
      // wired when an operator has run `pnpm vapid-keys` and set all
      // three env vars — otherwise web_push channels stay misconfigured
      // rather than dispatchDueAlerts ever calling setVapidDetails with
      // an incomplete/invalid identity.
      ...(config.VAPID_PUBLIC_KEY !== undefined &&
      config.VAPID_PRIVATE_KEY !== undefined &&
      config.VAPID_SUBJECT !== undefined
        ? {
            webPushVapid: {
              subject: config.VAPID_SUBJECT,
              publicKey: config.VAPID_PUBLIC_KEY,
              privateKey: config.VAPID_PRIVATE_KEY,
            },
          }
        : {}),
    }),
  );
  every(3_600_000, "maintenance", () => runMaintenance(ctx));
  every(60_000, "freshness", () => refreshProviderFreshness(ctx));
  // ADR 0007: sentiment/risk scan of LIVE/NEXT drops' X mentions. Self-gates
  // to a no-op unless X_SIGNALS_ENABLED + a real bearer token are set; 5-min
  // cadence keeps the metered X API cost bounded even when enabled.
  every(300_000, "sentiment", () => runSentimentScan(ctx));
  // ADR 0009, item P4: registered right before mint-execution and shares
  // its interval, so a just-armed plan usually gets its calldata cached
  // before it's claimed a cycle or more later — every() fires both as
  // independent, unawaited intervals, not a strict "pre-build always
  // completes first" guarantee, but that's fine: this only ever writes a
  // cache field, never changes plan status, so there's no race with the
  // atomic claim in mint-execution to worry about either way. See
  // pre-build.ts's own doc comment for why this triggers at arm-time
  // rather than a predicted stage-open time.
  every(config.MINT_WATCH_INTERVAL_SECONDS * 1000, "mint-prebuild", () =>
    runSpeculativePreBuild(ctx),
  );
  // ADR 0005/0008 (Phase 1): shadow-mode by default (LIVE_EXECUTION_ENABLED
  // false); claims at most one armed plan per pass, always simulates first,
  // never signs or broadcasts anything itself. This coarse pass is the
  // fallback/backstop; the fast hot-loop below is what wins FCFS races.
  every(config.MINT_WATCH_INTERVAL_SECONDS * 1000, "mint-execution", () =>
    runMintExecutionPass(ctx),
  );
  // ADR 0009 competitiveness: fast precision hot-loop. Fires a time-critical
  // armed plan AT its clock-corrected stage-open instant (not up to 30s late
  // on the coarse tick above) and keeps competing across the burst window.
  every(config.MINT_HOT_LOOP_INTERVAL_MS, "mint-hot-loop", () => runMintHotLoop(ctx));

  // ── Health server for compose ─────────────────────────────────────────────
  const health = http.createServer((req, res) => {
    if (req.url === "/health/live") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "worker" }));
      return;
    }
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(metrics().render());
      return;
    }
    res.writeHead(404);
    res.end();
  });
  health.listen(config.WORKER_HEALTH_PORT, "127.0.0.1");

  const shutdown = (): void => {
    log.info("worker shutting down");
    for (const timer of timers) {
      clearInterval(timer);
    }
    for (const worker of workers) {
      void worker.close();
    }
    health.close(() => {
      void dbClient(db)
        .end({ timeout: 5 })
        .then(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error: unknown) => {
  log.error({ err: error }, "worker failed to start");
  process.exit(1);
});

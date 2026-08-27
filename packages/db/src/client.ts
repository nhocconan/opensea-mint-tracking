import { sql as drizzleSql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Db = PostgresJsDatabase<typeof schema>;
/** Transaction handle accepted by repository methods (PRD §14). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createDb(url: string, options: { max?: number } = {}): Db {
  const client = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    // bigint columns must arrive as bigint, not number.
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (value: bigint): string => value.toString(),
        parse: (raw: string): bigint => BigInt(raw),
      },
    },
  });
  return drizzle(client, { schema });
}

/** Underlying postgres.js client (for shutdown) — cast is safe by construction. */
export function dbClient(db: Db): postgres.Sql {
  return (db as unknown as { $client: postgres.Sql }).$client;
}

/**
 * Normalize a raw `db.execute(sql\`...\`)` result to a plain row array —
 * the ONE place this unwrap lives (finding #10, code review 2026-08-23).
 * The postgres-js driver returns the row array DIRECTLY, with no `.rows`
 * wrapper, so the naive `result.rows ?? []` silently discarded every row
 * and produced a recurring class of silent-no-op bugs found live this
 * session (claimArmedMintPlan never claimed, testChannelAction always
 * "not found", retention counts always 0, provider-freshness never set).
 * Every raw-SQL call site now funnels through this instead of re-typing
 * the cast, so a future raw query can't reintroduce the bug. Works whether
 * or not a future driver wraps results in `.rows`.
 */
export function unwrapRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

const globalForDb = globalThis as unknown as { __hoodmintDb?: Db };

/** Process-wide singleton for request handling; scripts may create their own. */
export function getDb(url: string): Db {
  if (globalForDb.__hoodmintDb === undefined) {
    globalForDb.__hoodmintDb = createDb(url);
  }
  return globalForDb.__hoodmintDb;
}

/**
 * Postgres LISTEN/NOTIFY is the invalidation bus for SSE (PRD §8.5):
 * workers NOTIFY `radar_events`; the web process subscribes and fans out to
 * browser clients. Uses a dedicated connection per subscriber.
 */
export const EVENTS_CHANNEL = "radar_events";

export type RadarEventType =
  | "projects.invalidated"
  | "scan.completed"
  | "alert.sent"
  | "eligibility.updated"
  // ADR 0009, item P3: pushed the moment a mint plan reaches
  // ready_for_browser_signature, so the admin execution page (already
  // subscribed via AppShell's useRadarEvents, which wraps every page) can
  // auto-refresh into the sign prompt instead of waiting for a manual
  // reload or the 30s polling fallback.
  | "execution.awaiting_signature"
  // ADR 0004 Phase 2: a custom_executor (delegated, no-human-in-the-loop)
  // mint transaction was just signed and broadcast — distinct from
  // awaiting_signature above (which means the OPPOSITE: still waiting on
  // the owner). Lets the admin execution page push a "fired" update
  // immediately rather than only on the next poll.
  | "execution.broadcast";

export interface RadarEvent {
  readonly type: RadarEventType;
  readonly projectId?: string;
  readonly providerKind?: string;
  readonly at: string;
}

export async function publishEvent(db: Db, event: RadarEvent): Promise<void> {
  await db.execute(drizzleSql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(event)}::text)`);
}

export async function subscribeEvents(
  url: string,
  onEvent: (event: RadarEvent) => void,
): Promise<() => void> {
  const client = postgres(url, { max: 1, idle_timeout: 0 });
  await client.listen(EVENTS_CHANNEL, (payload) => {
    try {
      onEvent(JSON.parse(payload) as RadarEvent);
    } catch {
      // Ignore malformed notifications; SSE clients fall back to polling.
    }
  });
  // Ending the dedicated connection implicitly unsubscribes.
  return () => {
    void client.end({ timeout: 5 });
  };
}

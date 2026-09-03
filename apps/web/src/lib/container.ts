/**
 * Process-wide singletons for the Next server. Cached on globalThis so Next's
 * dev-mode module reloading and route-level isolation reuse one pool/client.
 */
import { EventEmitter } from "node:events";
import { type Auth, createAuth } from "@hoodmint/auth";
import { type AppConfig, loadEnv } from "@hoodmint/config";
import { type Db, getDb, type RadarEvent, subscribeEvents } from "@hoodmint/db";

export interface Container {
  readonly config: AppConfig;
  readonly db: Db;
  readonly auth: Auth;
  readonly events: EventEmitter;
}

const globalForContainer = globalThis as unknown as {
  __hoodmintContainer?: Container;
  __hoodmintEventSubscribed?: boolean;
};

export function container(): Container {
  if (globalForContainer.__hoodmintContainer === undefined) {
    const config = loadEnv();
    // Keep a deliberate per-process budget. With one web + one worker + the
    // dedicated LISTEN client, steady-state capacity stays far below
    // PostgreSQL's connection ceiling even during bursts and deploy overlap.
    const db = getDb(config.DATABASE_URL, { max: 6, applicationName: "hoodmint-web" });
    const auth = createAuth({
      db,
      secret: config.BETTER_AUTH_SECRET,
      baseUrl: config.APP_URL,
      secureCookies: config.APP_ENV === "production",
    });
    const events = new EventEmitter();
    events.setMaxListeners(100);
    globalForContainer.__hoodmintContainer = { config, db, auth, events };
  }
  return globalForContainer.__hoodmintContainer;
}

/**
 * Single Postgres LISTEN subscription per web process fanning out to all SSE
 * clients (PRD §8.5). Reconnects on error; SSE clients also poll as fallback.
 */
export function ensureEventSubscription(): void {
  const c = container();
  if (globalForContainer.__hoodmintEventSubscribed === true) {
    return;
  }
  globalForContainer.__hoodmintEventSubscribed = true;
  const stopping = false;

  const connect = (): void => {
    subscribeEvents(c.config.DATABASE_URL, (event: RadarEvent) => {
      c.events.emit("radar", event);
    }).catch(() => {
      if (!stopping) {
        setTimeout(connect, 5_000);
      }
    });
  };
  connect();
}

export type { RadarEvent };

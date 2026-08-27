/**
 * Structured logging (PRD §13): JSON with timestamp/level/service/event/
 * correlationId/jobId/provider/duration/outcome. Raw third-party payloads are
 * never logged by default, and standard secret-bearing keys are redacted at
 * the serializer level as defense in depth.
 */
import pino from "pino";

export interface LoggerOptions {
  readonly service: string;
  readonly level?: string;
}

export type Logger = pino.Logger;

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    name: options.service,
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "authorization",
        "cookie",
        "headers.authorization",
        "headers.cookie",
        "headers['x-api-key']",
        "apiKey",
        "api_key",
        "token",
        "accessToken",
        "access_token",
        "refreshToken",
        "password",
        "secret",
        "ciphertext",
        // ADR 0004 Phase 2: the Executor session key's raw material must
        // never reach a log line even accidentally (e.g. an error object
        // that happens to carry it as a field) — same defense-in-depth
        // posture as every other secret-bearing key above.
        "privateKey",
        "sessionKey",
        "*.authorization",
        "*.apiKey",
        "*.token",
        "*.privateKey",
        "*.sessionKey",
      ],
      censor: "[REDACTED]",
    },
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

const globalForLogger = globalThis as unknown as { __hoodmintLogger?: Logger };

/** Shared process logger for apps; pass bindings for per-request context. */
export function getLogger(service = "web"): Logger {
  if (globalForLogger.__hoodmintLogger === undefined) {
    globalForLogger.__hoodmintLogger = createLogger({ service });
  }
  return globalForLogger.__hoodmintLogger;
}

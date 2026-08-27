/**
 * API envelope + RFC 9457 problem details (PRD §10). Zod-validated requests;
 * cursor pagination; correlation id from ingress middleware.
 */

import { isAppError, safeErrorMessage } from "@hoodmint/core";
import { redactDeep } from "@hoodmint/secrets";
import { NextResponse } from "next/server";

export function envelope<T>(data: T, meta?: Record<string, unknown>): NextResponse {
  return NextResponse.json(meta === undefined ? { data } : { data, meta });
}

export function problem(
  status: number,
  title: string,
  detail: string,
  correlationId: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    {
      type: `https://hoodmint.dev/problems/${title.toLowerCase().replace(/\s+/g, "-")}`,
      title,
      status,
      detail,
      correlationId,
      ...(extra !== undefined ? { meta: redactDeep(extra) } : {}),
    },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

/** Uniform error mapping: AppError categories → problem responses. */
export function problemFromError(error: unknown, correlationId: string): NextResponse {
  if (isAppError(error)) {
    return problem(error.statusCode, error.category, safeErrorMessage(error), correlationId);
  }
  return problem(500, "internal", "unexpected server error", correlationId);
}

export interface ParsedPagination {
  readonly limit: number;
  readonly cursor: string | undefined;
}

export function parsePagination(
  _url: URL,
  schema: { limit: number; cursor?: string },
): ParsedPagination {
  return {
    limit: Math.min(Math.max(schema.limit, 1), 100),
    cursor: schema.cursor,
  };
}

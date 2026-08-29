import { bestEligibilityByProject, type FeedSort, type FeedView, queryFeed } from "@hoodmint/db";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { envelope, problem, problemFromError } from "@/lib/api.ts";
import { container } from "@/lib/container.ts";
import { getSessionUser } from "@/lib/session.ts";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  view: z.enum(["all", "live", "next", "latest", "eligible", "watchlist"]).default("all"),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(["recent", "starting", "velocity", "minted", "name", "discovered"]).optional(),
  price: z.enum(["free", "paid"]).optional(),
  wl: z.enum(["hit", "none"]).optional(),
  social: z.enum(["twitter", "website", "either", "both"]).optional(),
  status: z.enum(["LIVE", "NEXT", "ENDED", "SOLD_OUT", "PAUSED", "UNKNOWN"]).optional(),
  confidence: z.enum(["verified", "corroborated", "single-source", "unverified"]).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** GET /api/v1/projects — validated feed query with cursor pagination. */
export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = request.headers.get("x-correlation-id") ?? crypto.randomUUID();
  try {
    const parsed = querySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    if (!parsed.success) {
      return problem(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "invalid query",
        correlationId,
      );
    }
    const q = parsed.data;
    const user = await getSessionUser();
    if ((q.view === "watchlist" || q.view === "eligible") && user === null) {
      return problem(401, "AuthRequired", "sign in to use watchlist/eligible views", correlationId);
    }
    const { db } = container();
    const page = await queryFeed(db, {
      view: q.view as FeedView,
      userId: user?.id,
      search: q.q,
      sort: q.sort as FeedSort | undefined,
      price: q.price,
      wl: q.wl,
      social: q.social,
      status: q.status,
      confidence: q.confidence,
      cursor: q.cursor,
      limit: q.limit,
    });
    const eligibility = await bestEligibilityByProject(
      db,
      page.rows.map((row) => row.id),
    );
    return envelope(
      page.rows.map((row) => ({ ...row, eligibility: eligibility.get(row.id) ?? "UNKNOWN" })),
      {
        nextCursor: page.nextCursor,
        view: q.view,
      },
    );
  } catch (error) {
    return problemFromError(error, correlationId);
  }
}

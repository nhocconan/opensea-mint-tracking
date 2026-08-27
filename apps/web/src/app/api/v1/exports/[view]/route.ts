/**
 * CSV/JSON export of a feed view (PRD §7.7 — promised, never built until
 * now; `exports:read` has existed in packages/auth/rbac.ts's action list
 * since v1 with no route ever checking it, per repo inspection this
 * session). Operator+ only; no secret can appear here by construction —
 * FeedRow (the same shape /api/v1/projects returns) carries no credential
 * or auth-token field, so there is nothing to redact (PRD §11), unlike the
 * diagnostics export which handles that separately.
 */
import { can } from "@hoodmint/auth";
import { type FeedSort, type FeedView, queryFeed } from "@hoodmint/db";
import { z } from "zod";
import { container } from "@/lib/container.ts";
import { getSessionUser } from "@/lib/session.ts";

export const dynamic = "force-dynamic";

const VIEWS = ["all", "live", "next", "latest", "eligible", "watchlist"] as const;
const MAX_EXPORT_ROWS = 1000;

const querySchema = z.object({
  format: z.enum(["csv", "json"]).default("json"),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(["recent", "starting", "velocity", "minted", "name", "discovered"]).optional(),
});

const CSV_COLUMNS = [
  "id",
  "name",
  "chainId",
  "contractAddress",
  "lifecycleStatus",
  "confidence",
  "stageLabel",
  "stagePriceWei",
  "stageStartsAt",
  "minted",
  "maxSupply",
  "velocity1h",
  "uniqueMinters1h",
  "firstSeenAt",
] as const;

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  let s = value instanceof Date ? value.toISOString() : String(value);
  // CSV formula-injection guard (finding #9, code review 2026-08-23):
  // project names come from the public OpenSea feed, so an attacker can list
  // a drop named `=HYPERLINK(...)` / `+cmd` / `@SUM(...)`. Excel/Sheets
  // execute any cell beginning with = + - @ (or a leading tab/CR) as a
  // formula. Neutralize by prefixing a single quote — the standard OWASP
  // mitigation — before the quote-wrapping below.
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ view: string }> },
): Promise<Response> {
  const { view } = await params;
  if (!(VIEWS as readonly string[]).includes(view)) {
    return new Response("Not found", { status: 404 });
  }
  const user = await getSessionUser();
  if (!can(user?.role, "exports:read")) {
    return Response.json(
      { type: "https://hoodmint.dev/problems/forbidden", title: "Forbidden", status: 403 },
      { status: 403 },
    );
  }
  if ((view === "watchlist" || view === "eligible") && user === null) {
    return Response.json(
      { type: "https://hoodmint.dev/problems/auth-required", title: "AuthRequired", status: 401 },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return Response.json(
      {
        type: "https://hoodmint.dev/problems/invalid-request",
        title: "invalid_request",
        status: 400,
        detail: parsed.error.issues[0]?.message ?? "invalid query",
      },
      { status: 400 },
    );
  }
  const q = parsed.data;

  const { db } = container();
  const page = await queryFeed(db, {
    view: view as FeedView,
    userId: user?.id,
    search: q.q,
    sort: q.sort as FeedSort | undefined,
    limit: MAX_EXPORT_ROWS,
  });
  // Exports are a bounded snapshot (MAX_EXPORT_ROWS), not a paginated feed —
  // a response header flags truncation rather than silently capping.
  const truncated = page.nextCursor !== null;
  const truncationHeaders = truncated ? { "x-export-truncated": "true" } : {};

  if (q.format === "json") {
    return Response.json(
      { data: page.rows, meta: { view, rowCount: page.rows.length, truncated } },
      {
        headers: {
          "content-disposition": `attachment; filename="hoodmint-${view}.json"`,
          ...truncationHeaders,
        },
      },
    );
  }

  const header = CSV_COLUMNS.join(",");
  const lines = page.rows.map((row) =>
    CSV_COLUMNS.map((col) => csvEscape((row as unknown as Record<string, unknown>)[col])).join(","),
  );
  const csv = [header, ...lines].join("\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="hoodmint-${view}.csv"`,
      ...truncationHeaders,
    },
  });
}

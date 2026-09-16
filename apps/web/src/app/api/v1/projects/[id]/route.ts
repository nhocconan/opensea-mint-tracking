import { can } from "@hoodmint/auth";
import { eligibilityForProject, getProjectDetail, recentMintEvents } from "@hoodmint/db";
import type { NextRequest } from "next/server";
import { envelope, problem, problemFromError } from "@/lib/api.ts";
import { container } from "@/lib/container.ts";
import { getSessionUser } from "@/lib/session.ts";

export const dynamic = "force-dynamic";

/** GET /api/v1/projects/:id — detail payload with provenance (PRD §10). */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const correlationId = request.headers.get("x-correlation-id") ?? crypto.randomUUID();
  try {
    const { id } = await context.params;
    const { db } = container();
    const detail = await getProjectDetail(db, id);
    if (detail === undefined) {
      return problem(404, "not_found", `project ${id} not found`, correlationId);
    }
    // `eligibility` carries tracked-wallet ADDRESSES, their labels and how
    // many each may mint. This endpoint had no session check at all, and
    // /api/v1/projects hands out project ids to anonymous callers — so a
    // crawl of the list followed by one GET per id harvested every burner
    // address, its label, and its mint intent ahead of each drop. The rest
    // of the payload (public drop metadata) stays open; only the wallet half
    // is gated, using the same guard as /api/v1/exports.
    const user = await getSessionUser();
    const mayReadWallets = can(user?.role, "exports:read");
    const [eligibility, mints] = await Promise.all([
      mayReadWallets ? eligibilityForProject(db, id) : Promise.resolve([]),
      recentMintEvents(db, id, 25),
    ]);
    return envelope({
      project: detail.project,
      stages: detail.stages,
      supply: detail.supply[0] ?? null,
      aliases: detail.aliases,
      conflicts: detail.conflicts,
      eligibility,
      recentMints: mints,
    });
  } catch (error) {
    return problemFromError(error, correlationId);
  }
}

import { eligibilityForProject, getProjectDetail, recentMintEvents } from "@hoodmint/db";
import type { NextRequest } from "next/server";
import { envelope, problem, problemFromError } from "@/lib/api.ts";
import { container } from "@/lib/container.ts";

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
    const [eligibility, mints] = await Promise.all([
      eligibilityForProject(db, id),
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

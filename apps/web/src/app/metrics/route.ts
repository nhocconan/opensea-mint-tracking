import { metrics } from "@hoodmint/observability";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Prometheus text exposition (PRD §13). */
export function GET(): NextResponse {
  return new NextResponse(metrics().render(), {
    status: 200,
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}

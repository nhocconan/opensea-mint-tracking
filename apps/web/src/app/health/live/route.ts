import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness: process up — no dependency checks (PRD §13). */
export function GET(): NextResponse {
  return NextResponse.json({ status: "ok", service: "web" }, { status: 200 });
}

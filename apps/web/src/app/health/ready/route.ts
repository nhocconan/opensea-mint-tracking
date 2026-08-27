import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { container } from "@/lib/container.ts";

export const dynamic = "force-dynamic";

/** Readiness: DB reachable and migrations applied (uuidv7 exists on PG18). */
export async function GET(): Promise<NextResponse> {
  try {
    await container().db.execute(sql`select 1`);
    await container().db.execute(sql`select uuidv7()`);
    return NextResponse.json({ status: "ok", checks: { database: "ok" } }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        status: "unavailable",
        checks: { database: "down" },
        detail: error instanceof Error ? error.message.slice(0, 120) : "unknown",
      },
      { status: 503 },
    );
  }
}

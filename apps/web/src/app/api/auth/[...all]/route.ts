import type { NextRequest } from "next/server";
import { container } from "@/lib/container.ts";

export const dynamic = "force-dynamic";

/** Better Auth HTTP handler (sessions, 2FA, admin plugin endpoints). */
export async function ALL(request: NextRequest): Promise<Response> {
  return container().auth.handler(request);
}

export const GET = ALL;
export const POST = ALL;

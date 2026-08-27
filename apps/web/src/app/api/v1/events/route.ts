import { metrics } from "@hoodmint/observability";
import type { NextRequest } from "next/server";
import { container, ensureEventSubscription } from "@/lib/container.ts";

export const dynamic = "force-dynamic";

/**
 * SSE stream (PRD §8.5): small typed invalidation events only — the client
 * refetches affected queries; project payloads are never streamed. Falls
 * back transparently to client polling on disconnect.
 */
export async function GET(request: NextRequest): Promise<Response> {
  ensureEventSubscription();
  const { events } = container();
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let onEvent: ((event: unknown) => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      send({ type: "connected", at: new Date().toISOString() });
      globalForClients.__hoodmintSseClients = countClients() + 1;
      metrics().set("hoodmint_sse_clients", globalForClients.__hoodmintSseClients);

      onEvent = (event: unknown): void => {
        try {
          send(event);
        } catch {
          // Client went away; cleanup happens in cancel().
        }
      };
      events.on("radar", onEvent);

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // ignore
        }
      }, 15_000);

      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });

      function cleanup(): void {
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
        }
        if (onEvent !== undefined) {
          events.off("radar", onEvent);
        }
        globalForClients.__hoodmintSseClients = Math.max(0, countClients() - 1);
        metrics().set("hoodmint_sse_clients", globalForClients.__hoodmintSseClients);
      }
    },
    cancel() {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
      }
      if (onEvent !== undefined) {
        events.off("radar", onEvent);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

const globalForClients = globalThis as unknown as { __hoodmintSseClients?: number };

function countClients(): number {
  return globalForClients.__hoodmintSseClients ?? 0;
}

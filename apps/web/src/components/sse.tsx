"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * SSE invalidation hook (PRD §8.5): small typed events trigger a refetch of
 * server-rendered data via router.refresh(); a 30s polling fallback covers
 * disconnections. No project payloads are streamed.
 */
export function useRadarEvents(): void {
  const router = useRouter();

  useEffect(() => {
    let source: EventSource | null = null;
    let fallback: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    let lastEventAt = Date.now();

    const startFallback = (): void => {
      if (fallback === null) {
        fallback = setInterval(() => router.refresh(), 30_000);
      }
    };
    const stopFallback = (): void => {
      if (fallback !== null) {
        clearInterval(fallback);
        fallback = null;
      }
    };

    const connect = (): void => {
      if (stopped) {
        return;
      }
      source = new EventSource("/api/v1/events");
      source.onopen = () => {
        lastEventAt = Date.now();
        stopFallback();
      };
      source.onmessage = (event: MessageEvent<string>) => {
        lastEventAt = Date.now();
        try {
          const parsed = JSON.parse(event.data) as { type?: string };
          if (
            parsed.type === "projects.invalidated" ||
            parsed.type === "scan.completed" ||
            parsed.type === "eligibility.updated" ||
            // ADR 0009, item P3: refresh the instant a mint plan becomes
            // signable, instead of only on the next manual reload or the
            // 30s polling fallback below.
            parsed.type === "execution.awaiting_signature"
          ) {
            router.refresh();
          }
        } catch {
          // Ignore malformed events; polling fallback covers gaps.
        }
      };
      source.onerror = () => {
        source?.close();
        source = null;
        startFallback();
        // If quiet for a while without SSE, keep trying to reconnect.
        if (Date.now() - lastEventAt > 60_000) {
          setTimeout(connect, 5_000);
        } else {
          setTimeout(connect, 2_000);
        }
      };
    };

    connect();
    startFallback();

    return () => {
      stopped = true;
      source?.close();
      stopFallback();
    };
  }, [router]);
}

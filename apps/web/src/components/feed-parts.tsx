"use client";

import { Check, Copy, Loader2, Star } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { toggleWatchAction } from "@/app/actions.ts";

/** Live countdown in local time with UTC tooltip (PRD §5.2). */
export function Countdown({
  iso,
  label,
  pastPrefix = "ended",
}: {
  iso: string | null;
  label: string;
  /** Word for a target already in the past — "opened" for a stage start. */
  pastPrefix?: string;
}) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  if (iso === null) {
    return <span className="text-ink-faint">—</span>;
  }
  const target = Date.parse(iso);
  const delta = target - now;
  const past = delta < 0;
  const abs = Math.abs(delta);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1000);
  const text =
    days > 0
      ? `${days}d ${hours}h`
      : hours > 0
        ? `${hours}h ${minutes}m`
        : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return (
    <time
      dateTime={iso}
      title={`${label}: ${new Date(iso).toISOString()} (UTC)`}
      className="font-mono text-xs text-ink-muted tabular-nums"
    >
      {past ? `${pastPrefix} ` : ""}
      {text}
      {past ? " ago" : ""}
    </time>
  );
}

/** Copy affordance for raw hex addresses (PRD §14: no naked addresses). */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`${label}: copy ${value}`}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        });
      }}
      className="inline-flex size-6 flex-none items-center justify-center rounded-xs text-ink-faint transition-colors hover:text-acid"
    >
      {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
    </button>
  );
}

export function WatchButton({
  projectId,
  watched,
  enabled,
}: {
  projectId: string;
  watched: boolean;
  enabled: boolean;
}) {
  const [isWatched, setIsWatched] = useState(watched);
  const [pending, startTransition] = useTransition();

  if (!enabled) {
    return (
      <span
        title="Sign in to watch projects"
        className="inline-flex size-6 items-center justify-center"
      >
        <Star className="size-4 text-ink-faint/50" aria-hidden />
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={isWatched}
      aria-label={isWatched ? "Remove from watchlist" : "Add to watchlist"}
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          const next = await toggleWatchAction(projectId);
          setIsWatched(next);
        });
      }}
      className="inline-flex size-6 items-center justify-center rounded-xs disabled:opacity-50"
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin text-ink-faint" aria-hidden />
      ) : (
        <Star
          className={`size-4 ${isWatched ? "fill-acid text-acid" : "text-ink-faint hover:text-acid"}`}
          aria-hidden
        />
      )}
    </button>
  );
}

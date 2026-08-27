/**
 * Stage boundary semantics shared by status computation, scheduling, and the
 * detail timeline. All comparisons are half-open: [startsAt, endsAt).
 */
import { parseUtc } from "./time.ts";

export type StageKind = "public" | "allowlist" | "presale" | "gtd" | "community" | "unknown";

export interface StageView {
  readonly label: string;
  readonly kind: StageKind;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly paused: boolean;
}

/** A stage whose access is restricted (i.e. a real whitelist stage). */
export function isRestrictedStage(kind: StageKind): boolean {
  return kind !== "public";
}

export function stageStartsBefore(stage: StageView, isoNow: string): boolean {
  return parseUtc(stage.startsAt).getTime() <= parseUtc(isoNow).getTime();
}

export function isStageLive(stage: StageView, isoNow: string): boolean {
  const now = parseUtc(isoNow).getTime();
  if (parseUtc(stage.startsAt).getTime() > now) {
    return false;
  }
  if (stage.endsAt !== null && parseUtc(stage.endsAt).getTime() <= now) {
    return false;
  }
  return true;
}

export interface WindowedStage {
  readonly stage: StageView;
  /** Negative: future; positive: ended this many ms ago. */
  readonly msUntilStart: number;
  readonly msUntilEnd: number | null;
}

export function windowedStages(stages: readonly StageView[], isoNow: string): WindowedStage[] {
  const now = parseUtc(isoNow).getTime();
  return [...stages]
    .map((stage) => ({
      stage,
      msUntilStart: parseUtc(stage.startsAt).getTime() - now,
      msUntilEnd: stage.endsAt === null ? null : parseUtc(stage.endsAt).getTime() - now,
    }))
    .sort((a, b) => a.msUntilStart - b.msUntilStart);
}

/** The stage currently satisfying start <= now < end and not paused, if any. */
export function currentStage(stages: readonly StageView[], isoNow: string): StageView | undefined {
  return windowedStages(stages, isoNow).find(
    (w) => w.msUntilStart <= 0 && (w.msUntilEnd === null || w.msUntilEnd > 0) && !w.stage.paused,
  )?.stage;
}

/** Earliest future stage; ties broken by label for determinism. */
export function nextStage(stages: readonly StageView[], isoNow: string): StageView | undefined {
  const candidates = windowedStages(stages, isoNow)
    .filter((w) => w.msUntilStart > 0)
    .map((w) => w.stage);
  return candidates[0];
}

/** The stage a feed row should summarize: live stage, else next stage. */
export function relevantStage(stages: readonly StageView[], isoNow: string): StageView | undefined {
  return currentStage(stages, isoNow) ?? nextStage(stages, isoNow);
}

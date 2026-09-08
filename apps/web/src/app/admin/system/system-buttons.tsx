"use client";

import { useActionState, useMemo, useState, useTransition } from "react";
import {
  type ActionState,
  scanNowAction,
  setDemoModeAction,
  setSystemTimezoneAction,
} from "@/app/actions.ts";

export function ScanNowButton() {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, _formData: FormData) => scanNowAction(),
    { ok: false, message: "" },
  );
  return (
    <form action={formAction} className="flex items-center gap-2">
      <button
        type="submit"
        disabled={pending}
        className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
      >
        {pending ? "Enqueuing…" : "Run scan now"}
      </button>
      {state.message !== "" ? (
        <span
          role={state.ok ? "status" : "alert"}
          className={`text-xs ${state.ok ? "text-acid" : "text-magenta"}`}
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

export function DemoModeToggle({ enabled }: { enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(async () => void (await setDemoModeAction(!enabled)))}
      className="rounded-sm border border-amber/50 bg-amber/10 px-3 py-1.5 font-mono text-xs text-amber hover:bg-amber/20 disabled:opacity-50"
      aria-pressed={enabled}
    >
      {pending ? "…" : enabled ? "Disable demo mode" : "Enable demo mode"}
    </button>
  );
}

const COMMON_TIMEZONES = [
  { value: "Asia/Ho_Chi_Minh", label: "Asia/Ho_Chi_Minh (GMT+7 · Vietnam / Indochina) [Default]" },
  { value: "Asia/Bangkok", label: "Asia/Bangkok (GMT+7 · Thailand, Jakarta)" },
  { value: "Asia/Singapore", label: "Asia/Singapore (GMT+8 · Singapore, HK, Beijing)" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo (GMT+9 · Japan, Korea)" },
  { value: "UTC", label: "UTC (GMT+0 · Coordinated Universal Time)" },
  { value: "Europe/London", label: "Europe/London (GMT+0 / GMT+1 · London)" },
  { value: "America/New_York", label: "America/New_York (GMT-5 / GMT-4 · US Eastern)" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles (GMT-8 / GMT-7 · US Pacific)" },
] as const;

export function TimezoneSettingsForm({
  initialTimezone = "Asia/Ho_Chi_Minh",
}: {
  initialTimezone?: string;
}) {
  const [timezone, setTimezone] = useState(initialTimezone);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  // Preview current wall-clock time
  const previewTime = useMemo(() => {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date());
      const at = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((p) => p.type === type)?.value ?? "";
      const tzSuffix =
        timezone === "Asia/Ho_Chi_Minh" || timezone === "Asia/Bangkok" ? "GMT+7" : timezone;
      return `${at("year")}-${at("month")}-${at("day")} ${at("hour")}:${at("minute")}:${at("second")} ${tzSuffix}`;
    } catch {
      return "Invalid timezone";
    }
  }, [timezone]);

  const handleSave = () => {
    startTransition(async () => {
      setStatus(null);
      const res = await setSystemTimezoneAction(timezone);
      setStatus(res);
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2">
        <div>
          <h3 className="font-mono text-sm font-semibold text-ink">
            System Timezone (Múi Giờ Hệ Thống)
          </h3>
          <p className="text-xs text-ink-muted">
            Configures display timestamps across all feeds, calendar, NVT mints, and Discord alerts.
          </p>
        </div>
        <div className="rounded-sm border border-line bg-base px-2.5 py-1 font-mono text-xs text-acid">
          Clock: {previewTime}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="tz-select" className="block font-mono text-xs text-ink-faint mb-1">
            Common Timezones
          </label>
          <select
            id="tz-select"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            disabled={pending}
            className="w-full rounded-sm border border-line bg-base px-2.5 py-1.5 font-mono text-xs text-ink focus:border-acid focus:outline-none"
          >
            {COMMON_TIMEZONES.map((tz) => (
              <option key={tz.value} value={tz.value}>
                {tz.label}
              </option>
            ))}
            {!COMMON_TIMEZONES.some((tz) => tz.value === timezone) && (
              <option value={timezone}>Custom: {timezone}</option>
            )}
          </select>
        </div>

        <div>
          <label htmlFor="tz-input" className="block font-mono text-xs text-ink-faint mb-1">
            IANA Timezone Identifier
          </label>
          <input
            id="tz-input"
            type="text"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            disabled={pending}
            placeholder="e.g. Asia/Ho_Chi_Minh"
            className="w-full rounded-sm border border-line bg-base px-2.5 py-1.5 font-mono text-xs text-ink focus:border-acid focus:outline-none"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={pending}
          className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50 cursor-pointer"
        >
          {pending ? "Saving…" : "Save Timezone (Lưu Cài Đặt)"}
        </button>

        {status ? (
          <span
            role={status.ok ? "status" : "alert"}
            className={`font-mono text-xs ${status.ok ? "text-acid" : "text-magenta"}`}
          >
            {status.message}
          </span>
        ) : null}
      </div>
    </div>
  );
}

"use client";

import { AlertCircle, Bell, CheckCircle2, Play, Send } from "lucide-react";
import { useState, useTransition } from "react";
import {
  type ActionState,
  type NvtDiscordAdminData,
  type NvtTestResult,
  removeNvtDiscordWebhookAction,
  revokeCredentialAction,
  saveNvtApiKeyAction,
  saveNvtDiscordSettingsAction,
  testNvtApiKeyAction,
  testNvtDiscordWebhookAction,
  triggerNvtScanAndNotifyAction,
} from "@/app/actions.ts";
import { ConfirmDialog } from "@/components/confirm-dialog.tsx";
import { formatDateTime } from "@/lib/format.ts";

export function NvtApiKeyForm() {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<ActionState>({ ok: false, message: "" });

  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        NeverFuckingTrade API key
      </h2>
      <p className="mt-1 text-[11px] text-ink-muted">
        Generate your key at <span className="font-mono">neverfuckingtrade.com</span> under your
        profile &rarr; Alerts &amp; links &rarr; <b>MAKE KEY</b>. The key is encrypted with
        AES-256-GCM at rest and write-only after save.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const formData = new FormData(form);
          const value = String(formData.get("value") ?? "");
          startTransition(async () => {
            const res = await saveNvtApiKeyAction({ value });
            setState(res);
            if (res.ok) {
              form.reset();
            }
          });
        }}
        className="mt-3 space-y-2"
      >
        <input
          name="value"
          type="password"
          required
          autoComplete="off"
          placeholder="nftt_…"
          aria-label="NeverFuckingTrade API key"
          className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={pending}
            className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save encrypted key"}
          </button>
        </div>
        {state.message !== "" ? (
          <p
            role={state.ok ? "status" : "alert"}
            className={`text-xs ${state.ok ? "text-acid" : "text-magenta"}`}
          >
            {state.message}
          </p>
        ) : null}
      </form>
    </section>
  );
}

export function NvtTestButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<NvtTestResult | null>(null);

  const handleTest = () => {
    startTransition(async () => {
      const res = await testNvtApiKeyAction();
      setResult(res);
    });
  };

  return (
    <div className="mt-2 space-y-2">
      <button
        type="button"
        onClick={handleTest}
        disabled={pending}
        className="rounded-sm border border-cyan/50 bg-cyan/15 px-3 py-1.5 font-mono text-xs text-cyan hover:bg-cyan/25 disabled:opacity-50"
      >
        {pending ? "Testing connection…" : "Test connection (GET /api/v1/me)"}
      </button>

      {result !== null ? (
        <div
          role={result.ok ? "status" : "alert"}
          className={`rounded-sm border p-3 font-mono text-xs ${
            result.ok
              ? "border-acid/40 bg-acid/10 text-ink"
              : "border-magenta/40 bg-magenta/10 text-magenta"
          }`}
        >
          <p className="font-semibold">{result.message}</p>
          {result.ok ? (
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-ink-muted">
              {result.tier ? (
                <div>
                  <span className="text-ink-faint">Pass Tier: </span>
                  <span className="text-acid uppercase">{result.tier}</span>
                </div>
              ) : null}
              {result.usage !== undefined && result.limit !== undefined ? (
                <div>
                  <span className="text-ink-faint">Rate Quota: </span>
                  <span>
                    {result.usage} / {result.limit} req/min
                  </span>
                </div>
              ) : null}
              {result.prefix ? (
                <div>
                  <span className="text-ink-faint">Key Prefix: </span>
                  <span>{result.prefix}</span>
                </div>
              ) : null}
              {result.address ? (
                <div className="col-span-2 truncate">
                  <span className="text-ink-faint">Profile Address: </span>
                  <span className="text-cyan">{result.address}</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function RevokeNvtCredentialButton({ id }: { id: string }) {
  return (
    <ConfirmDialog
      triggerLabel="Revoke"
      triggerAriaLabel="Revoke NeverFuckingTrade credential"
      title="Revoke NeverFuckingTrade API key"
      confirmLabel="Revoke credential"
      consequence={
        <p>
          This permanently deletes the stored (encrypted) NeverFuckingTrade credential. Live mint
          tracking and whitelist eligibility checks relying on NVT will stop functioning until a new
          key is provided.
        </p>
      }
      onConfirm={() => revokeCredentialAction(id)}
    />
  );
}

export function NvtDiscordSettingsForm({ data }: { data: NvtDiscordAdminData }) {
  const [savePending, startSaveTransition] = useTransition();
  const [testPending, startTestTransition] = useTransition();
  const [scanPending, startScanTransition] = useTransition();

  const [saveState, setSaveState] = useState<ActionState>({ ok: false, message: "" });
  const [testState, setTestState] = useState<ActionState | null>(null);
  const [scanState, setScanState] = useState<ActionState | null>(null);

  const [enabled, setEnabled] = useState(data.settings.enabled);
  const [periodMinutes, setPeriodMinutes] = useState(data.settings.periodMinutes || 60);
  const [lookForwardHours, setLookForwardHours] = useState(data.settings.lookForwardHours || 24);

  const handleTest = () => {
    startTestTransition(async () => {
      const res = await testNvtDiscordWebhookAction();
      setTestState(res);
    });
  };

  const handleTriggerScan = () => {
    startScanTransition(async () => {
      const res = await triggerNvtScanAndNotifyAction();
      setScanState(res);
    });
  };

  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bell className="size-4 text-cyan" aria-hidden />
          <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
            Automated Discord Alerts &amp; Scan Schedule
          </h2>
        </div>
        <span
          className={`rounded-xs px-1.5 py-0.5 font-mono text-[9px] ${
            data.hasWebhook ? "bg-acid/15 text-acid" : "bg-ink-muted/15 text-ink-faint"
          }`}
        >
          {data.hasWebhook ? "WEBHOOK CONFIGURED" : "NO WEBHOOK"}
        </span>
      </div>

      <p className="mt-1 text-[11px] text-ink-muted">
        Automatically scans NeverFuckingTrade for allowlist eligibility across all your accounts and
        dispatches rich Discord embeds for upcoming and live mints.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const formData = new FormData(form);
          formData.set("enabled", String(enabled));
          formData.set("periodMinutes", String(periodMinutes));
          formData.set("lookForwardHours", String(lookForwardHours));
          startSaveTransition(async () => {
            const res = await saveNvtDiscordSettingsAction({ ok: false, message: "" }, formData);
            setSaveState(res);
          });
        }}
        className="mt-3 space-y-3"
      >
        <div>
          <label htmlFor="webhookUrl" className="block font-mono text-[11px] text-ink-muted">
            Discord Webhook URL
          </label>
          <input
            id="webhookUrl"
            name="webhookUrl"
            type="url"
            autoComplete="off"
            placeholder={
              data.hasWebhook
                ? `Saved encrypted webhook (${data.webhookFingerprint}) — enter new to replace`
                : "https://discord.com/api/webhooks/…"
            }
            className="mt-1 w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-xs"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="periodMinutes" className="block font-mono text-[11px] text-ink-muted">
              Scan Period (Cadence)
            </label>
            <select
              id="periodMinutes"
              value={periodMinutes}
              onChange={(e) => setPeriodMinutes(Number(e.target.value))}
              className="mt-1 w-full rounded-sm border border-line bg-base px-2.5 py-1.5 font-mono text-xs text-ink"
            >
              <option value={15}>Every 15 minutes</option>
              <option value={30}>Every 30 minutes</option>
              <option value={60}>Every 1 hour (Default / Hourly)</option>
              <option value={120}>Every 2 hours</option>
              <option value={360}>Every 6 hours</option>
              <option value={1440}>Every 24 hours</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="lookForwardHours"
              className="block font-mono text-[11px] text-ink-muted"
            >
              Look-Forward Window
            </label>
            <select
              id="lookForwardHours"
              value={lookForwardHours}
              onChange={(e) => setLookForwardHours(Number(e.target.value))}
              className="mt-1 w-full rounded-sm border border-line bg-base px-2.5 py-1.5 font-mono text-xs text-ink"
            >
              <option value={6}>Next 6 hours</option>
              <option value={12}>Next 12 hours</option>
              <option value={24}>Next 24 hours (Default)</option>
              <option value={48}>Next 48 hours</option>
              <option value={72}>Next 72 hours</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <input
            id="enabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="size-4 rounded border-line bg-base text-acid focus:ring-acid/40"
          />
          <label htmlFor="enabled" className="font-mono text-xs text-ink">
            Enable automated periodic background scans and Discord push
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="submit"
            disabled={savePending}
            className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
          >
            {savePending ? "Saving…" : "Save Settings"}
          </button>

          {data.hasWebhook ? (
            <>
              <button
                type="button"
                onClick={handleTest}
                disabled={testPending}
                className="inline-flex items-center gap-1.5 rounded-sm border border-cyan/50 bg-cyan/15 px-3 py-1.5 font-mono text-xs text-cyan hover:bg-cyan/25 disabled:opacity-50"
              >
                <Send className="size-3" />
                {testPending ? "Sending…" : "Test Webhook"}
              </button>

              <button
                type="button"
                onClick={handleTriggerScan}
                disabled={scanPending}
                className="inline-flex items-center gap-1.5 rounded-sm border border-magenta/50 bg-magenta/15 px-3 py-1.5 font-mono text-xs text-magenta hover:bg-magenta/25 disabled:opacity-50"
              >
                <Play className="size-3" />
                {scanPending ? "Scanning…" : "Scan & Push Now (Next 24h)"}
              </button>

              <ConfirmDialog
                triggerLabel="Remove Webhook"
                triggerAriaLabel="Remove Discord Webhook"
                title="Remove Discord Webhook"
                confirmLabel="Remove"
                consequence={
                  <p>
                    This deletes the stored Discord Webhook URL and pauses automated NVT alerts
                    until re-configured.
                  </p>
                }
                onConfirm={() => removeNvtDiscordWebhookAction()}
              />
            </>
          ) : null}
        </div>

        {saveState.message !== "" ? (
          <p
            role={saveState.ok ? "status" : "alert"}
            className={`text-xs ${saveState.ok ? "text-acid" : "text-magenta"}`}
          >
            {saveState.message}
          </p>
        ) : null}

        {testState !== null ? (
          <div
            role={testState.ok ? "status" : "alert"}
            className={`flex items-center gap-2 rounded-sm border p-2.5 font-mono text-xs ${
              testState.ok
                ? "border-acid/40 bg-acid/10 text-ink"
                : "border-magenta/40 bg-magenta/10 text-magenta"
            }`}
          >
            {testState.ok ? (
              <CheckCircle2 className="size-4 text-acid shrink-0" />
            ) : (
              <AlertCircle className="size-4 text-magenta shrink-0" />
            )}
            <span>{testState.message}</span>
          </div>
        ) : null}

        {scanState !== null ? (
          <div
            role={scanState.ok ? "status" : "alert"}
            className={`flex items-center gap-2 rounded-sm border p-2.5 font-mono text-xs ${
              scanState.ok
                ? "border-acid/40 bg-acid/10 text-ink"
                : "border-magenta/40 bg-magenta/10 text-magenta"
            }`}
          >
            {scanState.ok ? (
              <CheckCircle2 className="size-4 text-acid shrink-0" />
            ) : (
              <AlertCircle className="size-4 text-magenta shrink-0" />
            )}
            <span>{scanState.message}</span>
          </div>
        ) : null}

        {/* Scan Telemetry */}
        <div className="mt-3 rounded-sm border border-line/60 bg-base p-3 font-mono text-[11px] text-ink-muted">
          <div className="font-semibold text-ink-faint uppercase">Scan Execution Status</div>
          <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div>
              <span className="text-ink-faint">Last Run: </span>
              <span>
                {data.settings.lastRunAt
                  ? formatDateTime(new Date(data.settings.lastRunAt))
                  : "Never"}
              </span>
            </div>
            <div>
              <span className="text-ink-faint">Last Result: </span>
              <span
                className={
                  data.settings.lastStatus === "ok"
                    ? "text-acid font-semibold"
                    : data.settings.lastStatus === "error"
                      ? "text-magenta font-semibold"
                      : "text-ink-faint"
                }
              >
                {data.settings.lastStatus ? data.settings.lastStatus.toUpperCase() : "IDLE"}
              </span>
            </div>
            <div>
              <span className="text-ink-faint">Last Alerted Drops: </span>
              <span>{data.settings.lastAlertCount ?? 0}</span>
            </div>
          </div>
          {data.settings.lastErrorMessage ? (
            <div className="mt-1 text-magenta">Error: {data.settings.lastErrorMessage}</div>
          ) : null}
        </div>
      </form>
    </section>
  );
}

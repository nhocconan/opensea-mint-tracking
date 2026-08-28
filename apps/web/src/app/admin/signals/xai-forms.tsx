"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ActionState,
  pollXaiDeviceAuthAction,
  saveXaiApiKeyAction,
  saveXaiOAuthClientAction,
  startXaiDeviceAuthAction,
  type XaiDeviceAuthState,
} from "@/app/actions.ts";

const fieldClass =
  "w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm text-ink";
const buttonClass =
  "rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50";

function Result({ ok, message }: { ok: boolean; message: string }) {
  if (message === "") {
    return null;
  }
  return (
    <p role={ok ? "status" : "alert"} className={`text-xs ${ok ? "text-acid" : "text-magenta"}`}>
      {message}
    </p>
  );
}

/** console.x.ai API key — the alternative to the subscription grant. */
export function XaiApiKeyForm() {
  const [state, setState] = useState<ActionState>({ ok: false, message: "" });
  const [pending, setPending] = useState(false);

  return (
    <form
      className="mt-3 space-y-2"
      action={async (formData: FormData) => {
        setPending(true);
        setState(await saveXaiApiKeyAction({ value: String(formData.get("value") ?? "") }));
        setPending(false);
      }}
    >
      <label htmlFor="xai-api-key" className="block text-[11px] text-ink-muted">
        xAI API key
      </label>
      <input
        id="xai-api-key"
        name="value"
        type="password"
        required
        autoComplete="off"
        placeholder="paste key — encrypted on save"
        className={fieldClass}
      />
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Saving…" : "Save encrypted"}
      </button>
      <Result ok={state.ok} message={state.message} />
    </form>
  );
}

/** Optional override of the built-in public client id / endpoints. */
export function XaiClientOverrideForm() {
  const [state, setState] = useState<ActionState>({ ok: false, message: "" });
  const [pending, setPending] = useState(false);

  return (
    <details className="mt-3">
      <summary className="cursor-pointer font-mono text-[11px] text-ink-faint hover:text-ink-muted">
        Advanced: use your own xAI OAuth client
      </summary>
      <form
        className="mt-2 space-y-2"
        action={async (formData: FormData) => {
          setPending(true);
          setState(
            await saveXaiOAuthClientAction({
              clientId: String(formData.get("clientId") ?? ""),
              deviceAuthorizationUrl: String(formData.get("deviceAuthorizationUrl") ?? ""),
              tokenUrl: String(formData.get("tokenUrl") ?? ""),
              apiUrl: String(formData.get("apiUrl") ?? ""),
            }),
          );
          setPending(false);
        }}
      >
        <div>
          <label htmlFor="xai-client-id" className="block text-[11px] text-ink-muted">
            Client ID
          </label>
          <input
            id="xai-client-id"
            name="clientId"
            type="text"
            required
            autoComplete="off"
            spellCheck={false}
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor="xai-device-url" className="block text-[11px] text-ink-muted">
            Device authorization endpoint <span className="text-ink-faint">(optional)</span>
          </label>
          <input
            id="xai-device-url"
            name="deviceAuthorizationUrl"
            type="url"
            autoComplete="off"
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor="xai-token-url" className="block text-[11px] text-ink-muted">
            Token endpoint <span className="text-ink-faint">(optional)</span>
          </label>
          <input
            id="xai-token-url"
            name="tokenUrl"
            type="url"
            autoComplete="off"
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor="xai-api-url" className="block text-[11px] text-ink-muted">
            Inference API base <span className="text-ink-faint">(optional)</span>
          </label>
          <input
            id="xai-api-url"
            name="apiUrl"
            type="url"
            autoComplete="off"
            className={fieldClass}
          />
        </div>
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? "Saving…" : "Save override"}
        </button>
        <Result ok={state.ok} message={state.message} />
      </form>
    </details>
  );
}

type Phase = "idle" | "starting" | "waiting" | "settled";

/**
 * RFC 8628 device-grant UI: start the grant, show the user code and the
 * approval link, then poll on the server-supplied interval (honouring
 * `slow_down`) until it resolves. The device code itself never reaches this
 * component — only the short user code the operator types at x.ai.
 */
export function ConnectXaiButton() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [device, setDevice] = useState<XaiDeviceAuthState | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; message: string }>({
    ok: false,
    message: "",
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef(5);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  const poll = useCallback(async () => {
    const result = await pollXaiDeviceAuthAction();
    if (result.intervalSeconds !== undefined) {
      intervalRef.current = result.intervalSeconds;
    }
    if (result.status === "pending" || result.status === "slow_down") {
      setStatus({ ok: true, message: result.message });
      timer.current = setTimeout(() => {
        void poll();
      }, intervalRef.current * 1000);
      return;
    }
    setPhase("settled");
    setDevice(null);
    setStatus({ ok: result.status === "success", message: result.message });
  }, []);

  const start = useCallback(async () => {
    setPhase("starting");
    setStatus({ ok: false, message: "" });
    const started = await startXaiDeviceAuthAction();
    if (!started.ok) {
      setPhase("settled");
      setStatus({ ok: false, message: started.message });
      return;
    }
    intervalRef.current = started.intervalSeconds ?? 5;
    setDevice(started);
    setPhase("waiting");
    setStatus({ ok: true, message: started.message });
    timer.current = setTimeout(() => {
      void poll();
    }, intervalRef.current * 1000);
  }, [poll]);

  const approvalUrl = device?.verificationUriComplete ?? device?.verificationUri;

  return (
    <div className="mt-3 space-y-2">
      <button
        type="button"
        disabled={phase === "starting" || phase === "waiting"}
        onClick={() => {
          void start();
        }}
        className={buttonClass}
      >
        {phase === "starting"
          ? "Starting…"
          : phase === "waiting"
            ? "Waiting for approval…"
            : "Connect X (Grok) account"}
      </button>

      {device !== null && device.userCode !== undefined ? (
        <div className="rounded-sm border border-cyan/40 bg-cyan/5 p-3">
          <p className="text-[11px] text-ink-muted">
            1. Open x.ai and approve. 2. Confirm this code matches:
          </p>
          <p className="mt-1 font-mono text-lg tracking-[0.3em] text-cyan">{device.userCode}</p>
          {approvalUrl !== undefined ? (
            <a
              href={approvalUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-1 inline-block font-mono text-[11px] text-acid underline hover:no-underline"
            >
              Open x.ai to approve →
            </a>
          ) : null}
          <p aria-live="polite" className="mt-2 text-[11px] text-ink-faint">
            This page finishes automatically once you approve.
          </p>
        </div>
      ) : null}

      <Result ok={status.ok} message={status.message} />
    </div>
  );
}

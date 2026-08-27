"use client";

import { useEffect, useState } from "react";
import { subscribeWebPushAction, unsubscribeWebPushAction } from "@/app/actions.ts";

// RFC 8292's public key is base64url; PushManager.subscribe wants a raw
// Uint8Array applicationServerKey — this is the standard conversion every
// Web Push tutorial uses (there's no browser-native helper for it).
function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    bytes.push(raw.charCodeAt(i));
  }
  return Uint8Array.from(bytes);
}

type Status = "unsupported" | "checking" | "subscribed" | "unsubscribed" | "denied";

/**
 * Web Push opt-in for this device (feature-backlog.md, shipped
 * 2026-08-22). Deliberately NOT auto-run on page load: requesting
 * notification permission without a user gesture gets silently
 * auto-denied by every major browser and burns the one permission
 * prompt a site gets, so this only ever fires from a real click.
 */
export function PushSubscribeSection({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const [status, setStatus] = useState<Status>("checking");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatus("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }
    navigator.serviceWorker
      .getRegistration()
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => setStatus(sub !== null && sub !== undefined ? "subscribed" : "unsubscribed"))
      .catch(() => setStatus("unsubscribed"));
  }, []);

  if (vapidPublicKey === null) {
    return (
      <section className="rounded-md border border-line bg-base-raised p-4">
        <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Browser push
        </h2>
        <p className="mt-1 text-[11px] text-ink-muted">
          Not configured on this server — run <code>make vapid-keys</code> and set{" "}
          <code>VAPID_PUBLIC_KEY</code>/<code>VAPID_PRIVATE_KEY</code>/<code>VAPID_SUBJECT</code> to
          enable.
        </p>
      </section>
    );
  }
  if (status === "unsupported") {
    return (
      <section className="rounded-md border border-line bg-base-raised p-4">
        <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Browser push
        </h2>
        <p className="mt-1 text-[11px] text-ink-muted">
          This browser doesn't support Web Push (or you're on http:// — push requires https, except
          localhost).
        </p>
      </section>
    );
  }

  const subscribe = async (): Promise<void> => {
    setPending(true);
    setMessage("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("denied");
        setMessage("Permission denied — enable notifications for this site in browser settings.");
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
      const json = subscription.toJSON();
      if (
        json.endpoint === undefined ||
        json.keys?.p256dh === undefined ||
        json.keys.auth === undefined
      ) {
        setMessage("Subscription created but missing expected fields — try again.");
        return;
      }
      const result = await subscribeWebPushAction({
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        userAgent: navigator.userAgent,
      });
      setMessage(result.message);
      setStatus(result.ok ? "subscribed" : "unsubscribed");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Subscribe failed.");
    } finally {
      setPending(false);
    }
  };

  const unsubscribe = async (): Promise<void> => {
    setPending(true);
    setMessage("");
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription !== null && subscription !== undefined) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        const result = await unsubscribeWebPushAction(endpoint);
        setMessage(result.message);
      }
      setStatus("unsubscribed");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unsubscribe failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        Browser push
      </h2>
      <p className="mt-1 text-[11px] text-ink-muted">
        Buzz this device the instant a restricted stage opens — no bot setup, works even if
        Telegram/Discord are down. Per-device, not a shared secret.
      </p>
      <div className="mt-3">
        {status === "denied" ? (
          <p className="text-xs text-magenta">
            Notifications blocked for this site — re-enable in browser settings, then reload.
          </p>
        ) : status === "subscribed" ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void unsubscribe()}
            className="rounded-sm border border-line px-3 py-1.5 font-mono text-xs text-ink-muted hover:border-magenta/50 hover:text-magenta disabled:opacity-50"
          >
            {pending ? "…" : "Disable push on this device"}
          </button>
        ) : (
          <button
            type="button"
            disabled={pending || status === "checking"}
            onClick={() => void subscribe()}
            className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
          >
            {pending ? "…" : "Enable push on this device"}
          </button>
        )}
        {message !== "" ? (
          <p role="status" className="mt-2 text-xs text-ink-muted">
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

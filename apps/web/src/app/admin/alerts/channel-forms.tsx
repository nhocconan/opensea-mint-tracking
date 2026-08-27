"use client";

import { useActionState, useTransition } from "react";
import {
  type ActionState,
  saveDiscordChannelAction,
  saveTelegramChannelAction,
  saveWebhookChannelAction,
  testChannelAction,
} from "@/app/actions.ts";
import { PushSubscribeSection } from "./push-subscribe.tsx";

const initial: ActionState = { ok: false, message: "" };

export function ChannelForms({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  return (
    <div className="space-y-3">
      <TelegramForm />
      <DiscordForm />
      <WebhookForm />
      <PushSubscribeSection vapidPublicKey={vapidPublicKey} />
    </div>
  );
}

function TelegramForm() {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, formData: FormData) =>
      saveTelegramChannelAction({
        botToken: String(formData.get("botToken") ?? ""),
        chatId: String(formData.get("chatId") ?? ""),
        name: String(formData.get("name") ?? "Telegram"),
      }),
    initial,
  );
  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        Telegram channel
      </h2>
      <form action={formAction} className="mt-3 space-y-2">
        <input
          name="botToken"
          type="password"
          required
          autoComplete="off"
          placeholder="bot token (encrypted on save)"
          aria-label="Bot token"
          className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
        />
        <input
          name="chatId"
          required
          placeholder="chat id (-100… or @channel)"
          aria-label="Chat id"
          className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save Telegram channel"}
        </button>
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

function DiscordForm() {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, formData: FormData) =>
      saveDiscordChannelAction({
        url: String(formData.get("url") ?? ""),
        name: String(formData.get("name") ?? "Discord"),
      }),
    initial,
  );
  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        Discord channel
      </h2>
      <p className="mt-1 text-[11px] text-ink-muted">
        Rich embeds (title, stage/price/wallet fields, countdown) via a Discord webhook URL — same
        SSRF-guarded HTTPS delivery as the generic webhook below, no bot setup.
      </p>
      <form action={formAction} className="mt-3 space-y-2">
        <input
          name="url"
          type="url"
          required
          placeholder="https://discord.com/api/webhooks/…"
          aria-label="Discord webhook URL"
          className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save Discord channel"}
        </button>
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

function WebhookForm() {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, formData: FormData) =>
      saveWebhookChannelAction({
        url: String(formData.get("url") ?? ""),
        name: String(formData.get("name") ?? "Webhook"),
      }),
    initial,
  );
  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        Webhook channel
      </h2>
      <p className="mt-1 text-[11px] text-ink-muted">
        HTTPS only; private/loopback destinations rejected after DNS resolution; redirects never
        followed.
      </p>
      <form action={formAction} className="mt-3 space-y-2">
        <input
          name="url"
          type="url"
          required
          placeholder="https://hooks.example.com/…"
          aria-label="Webhook URL"
          className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save webhook"}
        </button>
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

export function TestButton({ channelId }: { channelId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(async () => void (await testChannelAction(channelId)))}
      className="rounded-xs border border-cyan/40 px-2 py-0.5 text-[11px] text-cyan hover:bg-cyan/10 disabled:opacity-50"
    >
      {pending ? "…" : "Test"}
    </button>
  );
}

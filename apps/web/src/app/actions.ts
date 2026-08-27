"use server";

import { isAppError } from "@hoodmint/core";
import {
  activateSigner,
  alertChannels,
  armMintPlan,
  consumeBootstrapToken,
  createCredential,
  createMintPlan as createMintPlanRepo,
  createRpcEndpoint,
  createSigner as createSignerRepo,
  createWallet as createWalletRepo,
  deleteRpcEndpoint,
  disarmMintPlan,
  ensureProvider,
  getCredentialSecret,
  getSigner,
  markExecutionAttemptBroadcast,
  markProviderHealth,
  recordAudit,
  revokeCredential,
  revokeSigner as revokeSignerRepo,
  setRpcEndpointEnabled,
  setSetting,
  setSignerDelegateContract,
  setSignerOnchainCeiling,
  sql,
  toggleWatch,
  unwrapRows,
  updateProvider,
  user as userTable,
} from "@hoodmint/db";
import {
  createDiscordAdapter,
  createTelegramAdapter,
  createWebhookAdapter,
  createWebPushAdapter,
} from "@hoodmint/notifications";
import {
  assertSafeRpcUrl,
  buildExecutorDeployData,
  buildSetAllowlistCalldata,
  buildSetOperatorCalldata,
} from "@hoodmint/providers";
import { enqueueMaintenance, enqueueRarity, queues } from "@hoodmint/queues";
import { fingerprint } from "@hoodmint/secrets";
import { generateSessionKey, parseBrowserSignResult } from "@hoodmint/signing";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { container } from "@/lib/container.ts";
import { getSessionUser, requireApi, requireFreshStepUp } from "@/lib/session.ts";

export interface ActionState {
  readonly ok: boolean;
  readonly message: string;
}

/** Watch toggle — operator-level action (PRD §7.6). */
export async function toggleWatchAction(projectId: string): Promise<boolean> {
  const user = await getSessionUser();
  if (user === null) {
    return false;
  }
  const { db } = container();
  const watched = await toggleWatch(db, user.id, projectId);
  revalidatePath("/", "layout");
  return watched;
}

/** Setup: consume one-time token, create the first admin, establish session. */
export async function setupAction(input: {
  token: string;
  email: string;
  name: string;
  password: string;
}): Promise<ActionState> {
  const { db, auth } = container();
  try {
    if (input.password.length < 12) {
      return { ok: false, message: "Password must be at least 12 characters." };
    }
    // 1. Single-use bootstrap token (fails closed on reuse/expiry).
    const consumed = await consumeBootstrapToken(db, fingerprint(input.token));
    if (!consumed) {
      return {
        ok: false,
        message:
          "Bootstrap token invalid, expired, or already used. Run `make token` for a fresh one.",
      };
    }
    // 2. Better Auth creates the account with a proper password hash; the
    //    signup hook allows this only while zero users exist.
    await auth.api.signUpEmail({
      body: { email: input.email, password: input.password, name: input.name },
    });
    // 3. Promote to admin.
    await db
      .update(userTable)
      .set({ role: "admin", emailVerified: true })
      .where(eq(userTable.email, input.email.toLowerCase()));
    // 4. Establish the session (cookies applied to this response).
    const response = await auth.api.signInEmail({
      body: { email: input.email, password: input.password },
      headers: await headers(),
      asResponse: true,
    });
    const setCookies = response.headers.getSetCookie();
    const cookieStore = await cookies();
    for (const cookie of setCookies) {
      const [pair, ...attrs] = cookie.split(";");
      const [name, ...rest] = (pair ?? "").split("=");
      if (name === undefined || rest.length === 0) {
        continue;
      }
      cookieStore.set(name.trim(), decodeURIComponent(rest.join("=")), {
        httpOnly: true,
        sameSite: "lax",
        secure: container().config.APP_ENV === "production",
        path: "/",
        ...(attrs.some((a) => a.trim().startsWith("Max-Age="))
          ? {
              maxAge: Number.parseInt(
                (attrs.find((a) => a.trim().startsWith("Max-Age=")) ?? "").split("=")[1] ??
                  "604800",
                10,
              ),
            }
          : {}),
      });
    }
    await recordAudit(db, {
      actorUserId: null,
      action: "bootstrap.admin_created",
      targetType: "user",
      targetId: input.email.toLowerCase(),
      result: "success",
    });
  } catch (error) {
    return {
      ok: false,
      message: isAppError(error)
        ? error.message
        : `Setup failed: ${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}`,
    };
  }
  redirect("/admin");
}

/** Enqueue an immediate discovery scan (operator+). */
export async function scanNowAction(): Promise<ActionState> {
  try {
    await requireApi("scans:run");
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const { db, config } = container();
  const correlationId = crypto.randomUUID();
  await recordAudit(db, {
    actorUserId: (await getSessionUser())?.id ?? null,
    action: "scan.now",
    targetType: "system",
    result: "success",
    correlationId,
  });
  await enqueueMaintenance(config.VALKEY_URL, { kind: "quota-log" });
  const discovery = queues(config.VALKEY_URL).discovery;
  await discovery.add(
    "discover",
    {
      dropType: "featured",
      windowStartMs: Date.now(),
    } as never,
    { jobId: `discover:manual:${Date.now()}` },
  );
  revalidatePath("/admin");
  return { ok: true, message: "Scan enqueued — watch Admin → Overview for the run." };
}

/**
 * Trait rarity refresh (feature-backlog.md §2, shipped 2026-08-22).
 * Same permission tier as scanNowAction above — an OpenSea read fetch, no
 * credential/execution risk, so "scans:run" (operator+) covers it rather
 * than inventing a new RBAC action for one more read-only trigger.
 */
export async function refreshRarityAction(projectId: string): Promise<ActionState> {
  try {
    await requireApi("scans:run");
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const { db, config } = container();
  const correlationId = crypto.randomUUID();
  await recordAudit(db, {
    actorUserId: (await getSessionUser())?.id ?? null,
    action: "rarity.refresh",
    targetType: "project",
    targetId: projectId,
    result: "success",
    correlationId,
  });
  await enqueueRarity(config.VALKEY_URL, { projectId });
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: "Rarity refresh enqueued — reload in a few seconds to see results." };
}

/** Create a wallet (operator+). */
export async function createWalletAction(input: {
  address: string;
  label: string;
}): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("wallets:manage");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const address = input.address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return { ok: false, message: "Invalid EVM address." };
  }
  await createWalletRepo(db, {
    address,
    ...(input.label.trim() !== "" ? { label: input.label.trim() } : {}),
  });
  await recordAudit(db, {
    actorUserId: actor,
    action: "wallet.create",
    targetType: "wallet",
    targetId: address,
    result: "success",
    metadata: { label: input.label },
  });
  revalidatePath("/admin/wallets");
  return { ok: true, message: "Wallet added." };
}

/** Store an OpenSea API key / PAT encrypted at rest (admin only). */
export async function saveCredentialAction(input: {
  type: "opensea_api_key" | "opensea_pat";
  value: string;
}): Promise<ActionState> {
  const { db, config } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("credentials:manage");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const value = input.value.trim();
  if (value.length < 8) {
    return { ok: false, message: "Value looks too short to be valid." };
  }
  await createCredential(db, {
    type: input.type,
    name: input.type === "opensea_pat" ? "OpenSea wallet PAT" : "OpenSea API key",
    secret: value,
    masterKey: config.APP_ENCRYPTION_KEY,
    createdBy: actor ?? undefined,
  });
  await recordAudit(db, {
    actorUserId: actor,
    action: "credential.create",
    targetType: "credential",
    targetId: input.type,
    result: "success",
    // No before/after secret values ever (PRD §11).
    metadata: { type: input.type },
  });
  revalidatePath("/admin/opensea");
  return {
    ok: true,
    message: "Saved and encrypted. Older keys of this type remain until revoked.",
  };
}

export async function revokeCredentialAction(id: string): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("credentials:manage");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const revoked = await revokeCredential(db, id);
  await recordAudit(db, {
    actorUserId: actor,
    action: "credential.revoke",
    targetType: "credential",
    targetId: id,
    result: revoked ? "success" : "failure",
  });
  revalidatePath("/admin/opensea");
  return { ok: revoked, message: revoked ? "Credential revoked." : "Credential not found." };
}

/** Configure a Telegram channel with an encrypted bot token (admin only). */
export async function saveTelegramChannelAction(input: {
  botToken: string;
  chatId: string;
  name: string;
}): Promise<ActionState> {
  const { db, config } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("alerts:configure");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const telegram = createTelegramAdapter();
  const invalid = telegram.validate({ botToken: input.botToken, chatId: input.chatId });
  if (invalid !== null) {
    return { ok: false, message: invalid.message };
  }
  const credential = await createCredential(db, {
    type: "telegram_bot",
    name: input.name.trim() || "Telegram",
    secret: JSON.stringify({ botToken: input.botToken, chatId: input.chatId }),
    masterKey: config.APP_ENCRYPTION_KEY,
    createdBy: actor ?? undefined,
  });
  await db.execute(
    sql`insert into alert_channels (id, kind, name, enabled, credential_id, config)
      values (gen_random_uuid(), 'telegram', ${input.name.trim() || "Telegram"}, true, ${credential.id}, '{}'::jsonb)`,
  );
  await recordAudit(db, {
    actorUserId: actor,
    action: "alert_channel.create",
    targetType: "alert_channel",
    result: "success",
    metadata: { kind: "telegram" },
  });
  revalidatePath("/admin/alerts");
  return { ok: true, message: "Telegram channel saved (encrypted)." };
}

export async function saveWebhookChannelAction(input: {
  url: string;
  name: string;
}): Promise<ActionState> {
  const { db, config } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("alerts:configure");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const webhook = createWebhookAdapter();
  const invalid = await webhook.validate({ url: input.url.trim() });
  if (invalid !== null) {
    return { ok: false, message: invalid.message };
  }
  const credential = await createCredential(db, {
    type: "webhook",
    name: input.name.trim() || "Webhook",
    secret: input.url.trim(),
    masterKey: config.APP_ENCRYPTION_KEY,
    createdBy: actor ?? undefined,
  });
  await db.execute(
    sql`insert into alert_channels (id, kind, name, enabled, credential_id, config)
      values (gen_random_uuid(), 'webhook', ${input.name.trim() || "Webhook"}, true, ${credential.id}, '{}'::jsonb)`,
  );
  await recordAudit(db, {
    actorUserId: actor,
    action: "alert_channel.create",
    targetType: "alert_channel",
    result: "success",
    metadata: { kind: "webhook" },
  });
  revalidatePath("/admin/alerts");
  return { ok: true, message: "Webhook saved (encrypted, SSRF-guarded)." };
}

/** Configure a Discord rich-embed channel (admin only). */
export async function saveDiscordChannelAction(input: {
  url: string;
  name: string;
}): Promise<ActionState> {
  const { db, config } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("alerts:configure");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const discord = createDiscordAdapter();
  const invalid = await discord.validate({ url: input.url.trim() });
  if (invalid !== null) {
    return { ok: false, message: invalid.message };
  }
  const credential = await createCredential(db, {
    type: "discord_webhook",
    name: input.name.trim() || "Discord",
    secret: input.url.trim(),
    masterKey: config.APP_ENCRYPTION_KEY,
    createdBy: actor ?? undefined,
  });
  await db.execute(
    sql`insert into alert_channels (id, kind, name, enabled, credential_id, config)
      values (gen_random_uuid(), 'discord', ${input.name.trim() || "Discord"}, true, ${credential.id}, '{}'::jsonb)`,
  );
  await recordAudit(db, {
    actorUserId: actor,
    action: "alert_channel.create",
    targetType: "alert_channel",
    result: "success",
    metadata: { kind: "discord" },
  });
  revalidatePath("/admin/alerts");
  return { ok: true, message: "Discord channel saved (encrypted, SSRF-guarded)." };
}

/**
 * Subscribe this browser to Web Push alerts (feature-backlog.md, shipped
 * 2026-08-22). Any logged-in user, not `alerts:configure` — unlike
 * Telegram/webhook/Discord, this isn't configuring a shared external
 * secret, it's a user opting their own device in, the same access level
 * as toggling their own watchlist. The subscription itself (endpoint +
 * encryption keys) comes from the browser's PushManager on the client,
 * captured by the client component that calls this action, never typed
 * by hand.
 */
export async function subscribeWebPushAction(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}): Promise<ActionState> {
  const { db, config } = container();
  // Finding #5 (code review 2026-08-23): must enforce alerts:configure like
  // every other alert-channel save action — a bare signed-in check let any
  // user (viewer role included) create an enabled channel and receive the
  // full text of restricted-eligibility alerts. A push subscription IS an
  // alert channel; gate it identically.
  let actor: string;
  try {
    actor = (await requireApi("alerts:configure")).id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  if (
    config.VAPID_PUBLIC_KEY === undefined ||
    config.VAPID_PRIVATE_KEY === undefined ||
    config.VAPID_SUBJECT === undefined
  ) {
    return {
      ok: false,
      message: "Web Push is not configured on this server (run `make vapid-keys`).",
    };
  }
  const webPush = createWebPushAdapter({
    subject: config.VAPID_SUBJECT,
    publicKey: config.VAPID_PUBLIC_KEY,
    privateKey: config.VAPID_PRIVATE_KEY,
  });
  const invalid = await webPush.validate({
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
  });
  if (invalid !== null) {
    return { ok: false, message: invalid.message };
  }
  const pushConfig = { endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth };
  const name =
    input.userAgent !== undefined && input.userAgent.trim() !== ""
      ? `Browser (${input.userAgent.trim().slice(0, 60)})`
      : "Browser push";
  // Idempotent by endpoint: re-subscribing the same device (page reload,
  // permission re-granted) updates the existing row instead of
  // accumulating duplicate channels that would each get sent the same alert.
  const existing = await db
    .select({ id: alertChannels.id })
    .from(alertChannels)
    .where(
      and(
        eq(alertChannels.kind, "web_push"),
        sql`${alertChannels.config}->>'endpoint' = ${input.endpoint}`,
      ),
    )
    .limit(1);
  if (existing[0] !== undefined) {
    await db
      .update(alertChannels)
      .set({ config: pushConfig, enabled: true, name, updatedAt: new Date() })
      .where(eq(alertChannels.id, existing[0].id));
  } else {
    await db
      .insert(alertChannels)
      .values({ kind: "web_push", name, enabled: true, config: pushConfig });
  }
  await recordAudit(db, {
    actorUserId: actor,
    action: "alert_channel.create",
    targetType: "alert_channel",
    result: "success",
    metadata: { kind: "web_push" },
  });
  revalidatePath("/admin/alerts");
  return { ok: true, message: "Push notifications enabled for this device." };
}

/** Unsubscribe this browser from Web Push alerts (best-effort match by endpoint). */
export async function unsubscribeWebPushAction(endpoint: string): Promise<ActionState> {
  const { db } = container();
  // Same alerts:configure gate as subscribe (finding #5) — managing alert
  // channels is an admin action, not a bare signed-in one.
  try {
    await requireApi("alerts:configure");
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  await db
    .delete(alertChannels)
    .where(
      and(
        eq(alertChannels.kind, "web_push"),
        sql`${alertChannels.config}->>'endpoint' = ${endpoint}`,
      ),
    );
  revalidatePath("/admin/alerts");
  return { ok: true, message: "Push notifications disabled for this device." };
}

/** Send a test message through a channel (admin only). */
export async function testChannelAction(channelId: string): Promise<ActionState> {
  const { db, config } = container();
  let _actor: string | null = null;
  try {
    const user = await requireApi("alerts:configure");
    _actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const rows = await db.execute(
    sql`select kind, credential_id, config from alert_channels where id = ${channelId}::uuid`,
  );
  // Centralized raw-result unwrap (finding #10) — see unwrapRows' own doc
  // comment for why the naive `.rows ?? []` silently broke this "Test"
  // button (and three other features) live this session.
  const row = unwrapRows<{ kind: string; credential_id: string | null; config: unknown }>(rows)[0];
  if (row === undefined) {
    return { ok: false, message: "Channel not found." };
  }
  // web_push is the one kind whose config lives unsealed in `config`
  // jsonb, not behind credential_id — see subscribeWebPushAction's doc
  // comment for why. Branch on kind before assuming a sealed credential
  // is required, or every push channel would incorrectly report "Channel
  // secret unavailable."
  if (row.kind === "web_push") {
    if (
      config.VAPID_PUBLIC_KEY === undefined ||
      config.VAPID_PRIVATE_KEY === undefined ||
      config.VAPID_SUBJECT === undefined
    ) {
      return { ok: false, message: "Web Push is not configured on this server." };
    }
    const pushConfig = row.config as { endpoint?: string; p256dh?: string; auth?: string } | null;
    if (
      pushConfig === null ||
      typeof pushConfig.endpoint !== "string" ||
      typeof pushConfig.p256dh !== "string" ||
      typeof pushConfig.auth !== "string"
    ) {
      return { ok: false, message: "Push subscription data missing or malformed." };
    }
    const result = await createWebPushAdapter({
      subject: config.VAPID_SUBJECT,
      publicKey: config.VAPID_PUBLIC_KEY,
      privateKey: config.VAPID_PRIVATE_KEY,
    }).sendTest({
      endpoint: pushConfig.endpoint,
      p256dh: pushConfig.p256dh,
      auth: pushConfig.auth,
    });
    return {
      ok: result.ok,
      message: result.ok ? "Test delivered." : `Failed: ${result.errorCode}`,
    };
  }
  if (row.credential_id === null) {
    return { ok: false, message: "Channel secret unavailable." };
  }
  const secret = await getCredentialSecret(db, row.credential_id, config.APP_ENCRYPTION_KEY);
  if (secret === undefined) {
    return { ok: false, message: "Channel secret unavailable." };
  }
  if (row.kind === "telegram") {
    const parsed = JSON.parse(secret) as { botToken: string; chatId: string };
    const result = await createTelegramAdapter().sendTest(parsed);
    return {
      ok: result.ok,
      message: result.ok ? "Test delivered." : `Failed: ${result.errorCode}`,
    };
  }
  if (row.kind === "discord") {
    const result = await createDiscordAdapter().sendTest({ url: secret });
    return {
      ok: result.ok,
      message: result.ok ? "Test delivered." : `Failed: ${result.errorCode}`,
    };
  }
  const result = await createWebhookAdapter().sendTest({ url: secret });
  return { ok: result.ok, message: result.ok ? "Test delivered." : `Failed: ${result.errorCode}` };
}

/** Toggle a provider source on/off (admin only). */
export async function toggleProviderAction(kind: string, enabled: boolean): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("providers:configure");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const provider = await ensureProvider(
    db,
    kind as "opensea" | "robinhood_rpc" | "calendar" | "manual",
  );
  await updateProvider(db, provider.id, { enabled });
  await recordAudit(db, {
    actorUserId: actor,
    action: "provider.toggle",
    targetType: "provider",
    targetId: kind,
    result: "success",
    metadata: { enabled },
  });
  revalidatePath("/admin/sources");
  return { ok: true, message: `${kind} ${enabled ? "enabled" : "disabled"}.` };
}

/** Demo mode switch (admin only) — drives the persistent DEMO banner. */
export async function setDemoModeAction(enabled: boolean): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("system:operate");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  await setSetting(db, "demo_mode", enabled);
  await recordAudit(db, {
    actorUserId: actor,
    action: "system.demo_mode",
    targetType: "system",
    result: "success",
    metadata: { enabled },
  });
  revalidatePath("/", "layout");
  return { ok: true, message: enabled ? "Demo mode on." : "Demo mode off." };
}

export async function ensureDefaultsAction(): Promise<ActionState> {
  const { db } = container();
  try {
    await requireApi("system:operate");
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  await ensureProvider(db, "opensea");
  await ensureProvider(db, "robinhood_rpc");
  await markProviderHealth(db, "opensea", "unknown");
  return { ok: true, message: "Provider registry ensured." };
}

/* ── Execution (ADR 0003–0008; docs/execution-architecture.md) ───────────────
 * Phase 1 only. Every action here is `execution:configure` or
 * `execution:operate` — admin-only (packages/auth/rbac.ts), never granted
 * to operator by default. Arming a plan requires WebAuthn step-up
 * re-authentication (ADR 0008), which is not wired into this UI yet — see
 * the roadmap doc. No action below can cause a real signature: the only
 * signer scheme that can ever proceed to signing is `browser_wallet`
 * (the owner's own wallet, client-side), and even that only fires once a
 * plan is armed, which nothing here does yet.
 */

export async function createRpcEndpointAction(input: {
  chainId: number;
  label: string;
  httpUrl: string;
  wsUrl: string;
}): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("execution:configure");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  if (!Number.isInteger(input.chainId) || input.chainId <= 0) {
    return { ok: false, message: "Invalid chain id." };
  }
  if (input.label.trim() === "") {
    return { ok: false, message: "Label is required." };
  }
  // SSRF guard (defense-in-depth): the worker makes real outbound requests
  // to every configured endpoint, so a metadata-service URL here — typo'd
  // or from a compromised admin session — must not become a pivot into
  // cloud credentials. Private/LAN addresses stay allowed: a self-hosted
  // node is a legitimate target (ADR 0006).
  try {
    await assertSafeRpcUrl(input.httpUrl.trim());
    if (input.wsUrl.trim() !== "") {
      await assertSafeRpcUrl(input.wsUrl.trim());
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Invalid RPC URL.",
    };
  }
  const created = await createRpcEndpoint(db, {
    chainId: input.chainId,
    label: input.label.trim(),
    httpUrl: input.httpUrl.trim(),
    ...(input.wsUrl.trim() !== "" ? { wsUrl: input.wsUrl.trim() } : {}),
  });
  await recordAudit(db, {
    actorUserId: actor,
    action: "execution.rpc_endpoint.create",
    targetType: "rpc_endpoint",
    targetId: created.id,
    result: "success",
    metadata: { chainId: input.chainId, label: input.label },
  });
  revalidatePath("/admin/execution");
  return { ok: true, message: `RPC endpoint "${input.label}" added.` };
}

export async function setRpcEndpointEnabledAction(
  id: string,
  enabled: boolean,
): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("execution:configure");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  await setRpcEndpointEnabled(db, id, enabled);
  await recordAudit(db, {
    actorUserId: actor,
    action: "execution.rpc_endpoint.toggle",
    targetType: "rpc_endpoint",
    targetId: id,
    result: "success",
    metadata: { enabled },
  });
  revalidatePath("/admin/execution");
  return { ok: true, message: enabled ? "Endpoint enabled." : "Endpoint disabled." };
}

export async function deleteRpcEndpointAction(id: string, chainId: number): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("execution:configure");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  await deleteRpcEndpoint(db, id, chainId);
  await recordAudit(db, {
    actorUserId: actor,
    action: "execution.rpc_endpoint.delete",
    targetType: "rpc_endpoint",
    targetId: id,
    result: "success",
  });
  revalidatePath("/admin/execution");
  return { ok: true, message: "Endpoint removed." };
}

/**
 * Registers a `browser_wallet` signer only (ADR 0004/0008): the owner's own
 * address, immediately usable, zero server custody. Delegated schemes
 * (`eip7702_safe_zodiac`, `custom_executor`) are not offered here — Phase 2
 * custody is not implemented; see docs/execution-architecture.md.
 */
export async function registerBrowserSignerAction(input: {
  chainId: number;
  ownerAddress: string;
}): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("execution:configure");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const address = input.ownerAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return { ok: false, message: "Invalid EVM address." };
  }
  const created = await createSignerRepo(db, {
    chainId: input.chainId,
    ownerAddress: address,
    scheme: "browser_wallet",
  });
  await recordAudit(db, {
    actorUserId: actor,
    action: "execution.signer.create",
    targetType: "signer",
    targetId: created.id,
    result: "success",
    metadata: { chainId: input.chainId, scheme: "browser_wallet" },
  });
  revalidatePath("/admin/execution");
  return { ok: true, message: "Browser-wallet signer registered." };
}

export async function revokeSignerAction(id: string): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("execution:configure");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  await revokeSignerRepo(db, id);
  await recordAudit(db, {
    actorUserId: actor,
    action: "execution.signer.revoke",
    targetType: "signer",
    targetId: id,
    result: "success",
  });
  revalidatePath("/admin/execution");
  return { ok: true, message: "Signer revoked." };
}

/* ── ADR 0004 Phase 2 (custom_executor) onboarding ──────────────────────────
 * A five-step, all-owner-reviewed sequence: (1) generate a session key and
 * a pending signer row, (2) the owner deploys MintExecutor from their own
 * wallet, (3) the owner calls setOperator, (4) the owner calls
 * setAllowlist once per collection (never batched, per ADR 0004), (5) the
 * owner explicitly activates the signer once they've confirmed every prior
 * step landed on-chain. Every state-changing step here requires a FRESH
 * step-up (WebAuthn within the last 2 minutes, same bar as arming a mint
 * plan) — this sequence is the root of a real custody chain, at least as
 * sensitive as anything else gated that way in this codebase. The two pure
 * calldata-builder actions below mutate nothing and are gated by the
 * ordinary role check; the owner's own wallet signature is the real gate
 * on those. */

export interface ExecutorOnboardingStart {
  readonly signerId: string;
  readonly operatorAddress: string;
  readonly deployData: string;
  readonly chainId: number;
}

/** Step 1: generate a session key (sealed immediately, never returned in
 *  plaintext), create the pending signer row, and return the deployment
 *  calldata for the owner's own wallet to send (no `to` — a contract
 *  creation). */
export async function startExecutorOnboardingAction(
  ownerAddress: string,
): Promise<ActionState & { data?: ExecutorOnboardingStart }> {
  const { db, config } = container();
  let actor: string;
  try {
    const user = await requireFreshStepUp("execution:configure");
    actor = user.id;
  } catch (error) {
    return {
      ok: false,
      message: isAppError(error) ? error.message : "Step-up re-authentication required.",
    };
  }
  const owner = ownerAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(owner)) {
    return { ok: false, message: "Invalid EVM address." };
  }
  const generated = generateSessionKey();
  const credential = await createCredential(db, {
    type: "delegated_session_key",
    name: `Executor operator (${owner.slice(0, 10)}…)`,
    secret: generated.privateKeyHex,
    masterKey: config.APP_ENCRYPTION_KEY,
    createdBy: actor,
    metadata: { operatorAddress: generated.address },
  });
  const signer = await createSignerRepo(db, {
    chainId: config.ROBINHOOD_CHAIN_ID,
    ownerAddress: owner,
    scheme: "custom_executor",
    sessionKeyCredentialId: credential.id,
  });
  await recordAudit(db, {
    actorUserId: actor,
    action: "execution.executor.onboarding_started",
    targetType: "signer",
    targetId: signer.id,
    result: "success",
    // The operator ADDRESS is not a secret — logging it is exactly what
    // the ADR 0004 audit trail needs; the private key never appears here.
    metadata: { operatorAddress: generated.address },
  });
  revalidatePath("/admin/execution");
  return {
    ok: true,
    message: "Session key generated. Deploy the Executor from your own wallet next.",
    data: {
      signerId: signer.id,
      operatorAddress: generated.address,
      deployData: buildExecutorDeployData(owner),
      chainId: config.ROBINHOOD_CHAIN_ID,
    },
  };
}

/** Step 2 confirmation: the owner's deploy transaction confirmed on-chain
 *  (verified in the browser via the tx receipt before this is called) —
 *  records the real Executor address. */
export async function recordExecutorDeployedAction(
  signerId: string,
  executorAddress: string,
): Promise<ActionState> {
  const { db } = container();
  let actor: string;
  try {
    const user = await requireFreshStepUp("execution:configure");
    actor = user.id;
  } catch (error) {
    return {
      ok: false,
      message: isAppError(error) ? error.message : "Step-up re-authentication required.",
    };
  }
  const address = executorAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return { ok: false, message: "Invalid Executor contract address." };
  }
  await setSignerDelegateContract(db, signerId, address);
  await recordAudit(db, {
    actorUserId: actor,
    action: "execution.executor.deployed",
    targetType: "signer",
    targetId: signerId,
    result: "success",
    metadata: { executorAddress: address },
  });
  revalidatePath("/admin/execution");
  return { ok: true, message: "Executor address recorded. Call setOperator next." };
}

/** Pure calldata builder — mutates nothing, the owner's wallet signature
 *  downstream is the real gate. */
export async function prepareSetOperatorCalldataAction(
  operatorAddress: string,
): Promise<ActionState & { data?: string }> {
  try {
    await requireApi("execution:configure");
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const address = operatorAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return { ok: false, message: "Invalid operator address." };
  }
  return { ok: true, message: "", data: buildSetOperatorCalldata(address) };
}

/** Pure calldata builder for one collection's allowlist entry. Never
 *  batches — the caller (the onboarding UI) must invoke this once per
 *  collection, each requiring its own separate owner wallet signature, per
 *  ADR 0004's non-batched discipline. */
export async function prepareSetAllowlistCalldataAction(input: {
  target: string;
  selector: string;
  recipientOffset: number;
  valueCapWei: string;
}): Promise<ActionState & { data?: string }> {
  try {
    await requireApi("execution:configure");
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const target = input.target.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(target)) {
    return { ok: false, message: "Invalid target contract address." };
  }
  if (!/^0x[0-9a-f]{8}$/.test(input.selector.trim().toLowerCase())) {
    return { ok: false, message: "Invalid 4-byte function selector." };
  }
  if (!Number.isInteger(input.recipientOffset) || input.recipientOffset < 4) {
    return { ok: false, message: "Recipient offset must be an integer ≥ 4 (past the selector)." };
  }
  let valueCapWei: bigint;
  try {
    valueCapWei = BigInt(input.valueCapWei);
  } catch {
    return { ok: false, message: "Invalid value cap." };
  }
  return {
    ok: true,
    message: "",
    data: buildSetAllowlistCalldata({
      target,
      selector: input.selector.trim().toLowerCase(),
      allowed: true,
      recipientOffset: BigInt(input.recipientOffset),
      valueCapWei,
    }),
  };
}

/** Step 5: the owner explicitly confirms every prior on-chain step landed,
 *  and records the collection's coarse cap (mirroring what was actually
 *  set on-chain via setAllowlist — see setSignerOnchainCeiling's own doc
 *  comment on why this must always match, never drift ahead). Only after
 *  this does the worker's execution pass ever treat this signer as
 *  capable (apps/worker's execution.ts checks status === 'active'). */
export async function activateExecutorSignerAction(
  signerId: string,
  onchainSpendCeilingWei: string,
): Promise<ActionState> {
  const { db } = container();
  let actor: string;
  try {
    const user = await requireFreshStepUp("execution:configure");
    actor = user.id;
  } catch (error) {
    return {
      ok: false,
      message: isAppError(error) ? error.message : "Step-up re-authentication required.",
    };
  }
  const signer = await getSigner(db, signerId);
  if (signer === undefined || signer.scheme !== "custom_executor") {
    return { ok: false, message: "Signer not found or not a custom_executor scheme." };
  }
  if (signer.delegateContractAddress === null) {
    return { ok: false, message: "Executor address not recorded yet — complete deployment first." };
  }
  let cap: bigint;
  try {
    cap = BigInt(onchainSpendCeilingWei);
  } catch {
    return { ok: false, message: "Invalid spend ceiling." };
  }
  if (cap <= 0n) {
    return { ok: false, message: "Spend ceiling must be positive." };
  }
  await setSignerOnchainCeiling(db, signerId, cap.toString(10));
  await activateSigner(db, signerId);
  await recordAudit(db, {
    actorUserId: actor,
    action: "execution.executor.activated",
    targetType: "signer",
    targetId: signerId,
    result: "success",
    metadata: { onchainSpendCeilingWei: cap.toString(10) },
  });
  revalidatePath("/admin/execution");
  return { ok: true, message: "Signer activated — the worker can now use it for live execution." };
}

/** Creates a mint plan in `draft` status only — arming is a separate, step-up-gated action below. */
export async function createMintPlanAction(input: {
  projectId: string;
  walletId: string;
  quantity: number;
  perPlanCeilingWei: string;
}): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("execution:operate");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(input.projectId)) {
    return { ok: false, message: "Pick a project from the search results." };
  }
  if (!uuid.test(input.walletId)) {
    return { ok: false, message: "Select a wallet." };
  }
  if (!/^[0-9]+$/.test(input.perPlanCeilingWei) || input.perPlanCeilingWei === "0") {
    return { ok: false, message: "Per-plan ceiling must be a positive wei amount." };
  }
  // Math.max(1, NaN) is NaN, not 1 — an empty/non-numeric quantity field
  // must fail closed with a clear message, not insert a NaN quantity.
  if (!Number.isFinite(input.quantity)) {
    return { ok: false, message: "Quantity must be a number." };
  }
  const created = await createMintPlanRepo(db, {
    projectId: input.projectId,
    walletId: input.walletId,
    quantity: Math.max(1, Math.floor(input.quantity)),
    perPlanCeilingWei: input.perPlanCeilingWei,
  });
  await recordAudit(db, {
    actorUserId: actor,
    action: "execution.mint_plan.create",
    targetType: "mint_plan",
    targetId: created.id,
    result: "success",
    metadata: { projectId: input.projectId, walletId: input.walletId },
  });
  revalidatePath("/admin/execution");
  return { ok: true, message: "Mint plan created as draft (not armed)." };
}

/**
 * Arms a draft plan — the ONE action in this codebase that puts a plan into
 * a state the worker's execution loop will act on (ADR 0005/0008). Gated by
 * `requireFreshStepUp`, not `requireApi`: a valid admin session is
 * necessary but not sufficient — the caller must have completed a WebAuthn
 * passkey ceremony within the last 2 minutes (packages/auth/src/auth.ts's
 * `after` hook is what actually proves that, server-side; this action just
 * checks the stamp it left). Even once armed, LIVE_EXECUTION_ENABLED
 * defaults false (shadow mode) and the only signer scheme that can ever
 * sign anything is `browser_wallet` — the owner's own wallet, requiring
 * its own separate, physical confirmation at fire time.
 */
export async function armMintPlanAction(id: string, windowMinutes: number): Promise<ActionState> {
  const { db } = container();
  let actor: string;
  try {
    const user = await requireFreshStepUp("execution:operate");
    actor = user.id;
  } catch (error) {
    return {
      ok: false,
      message: isAppError(error) ? error.message : "Step-up re-authentication required.",
    };
  }
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0 || windowMinutes > 60) {
    return { ok: false, message: "Arm window must be between 1 and 60 minutes." };
  }
  const armed = await armMintPlan(db, id, actor, windowMinutes);
  if (armed === undefined) {
    return { ok: false, message: "Plan is not in draft status — nothing to arm." };
  }
  await recordAudit(db, {
    actorUserId: actor,
    action: "execution.mint_plan.arm",
    targetType: "mint_plan",
    targetId: id,
    result: "success",
    metadata: { windowMinutes },
  });
  revalidatePath("/admin/execution");
  return { ok: true, message: `Armed for ${windowMinutes} minute(s).` };
}

/** Disarm does not need step-up — it can only ever make things safer, never fire a mint. */
export async function disarmMintPlanAction(id: string): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("execution:operate");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const disarmed = await disarmMintPlan(db, id);
  if (disarmed === undefined) {
    return { ok: false, message: "Plan is not armed — nothing to disarm." };
  }
  await recordAudit(db, {
    actorUserId: actor,
    action: "execution.mint_plan.disarm",
    targetType: "mint_plan",
    targetId: id,
    result: "success",
  });
  revalidatePath("/admin/execution");
  return { ok: true, message: "Disarmed." };
}

/**
 * Records what the owner's OWN browser wallet reported after they approved
 * a transaction and it broadcast — this action never signs or broadcasts
 * anything itself, it only writes down a result the wallet already
 * produced (ADR 0008 Phase 1). The real security boundary already passed:
 * the owner physically approved this in their wallet's own UI before this
 * was ever called.
 */
export async function recordBrowserSignatureAction(
  attemptId: string,
  txHash: string,
): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("execution:operate");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  let parsed: { planId: string; txHash: string };
  try {
    // planId isn't used here (we key by attemptId); this call is really
    // just validating txHash shape, reusing packages/signing's own check
    // rather than duplicating the regex.
    parsed = parseBrowserSignResult({ planId: attemptId, txHash });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Invalid tx hash." };
  }
  const updated = await markExecutionAttemptBroadcast(db, attemptId, parsed.txHash);
  if (updated === undefined) {
    return { ok: false, message: "That attempt is no longer awaiting a signature." };
  }
  await recordAudit(db, {
    actorUserId: actor,
    action: "execution.attempt.browser_broadcast",
    targetType: "execution_attempt",
    targetId: attemptId,
    result: "success",
    metadata: { txHash: parsed.txHash },
  });
  revalidatePath("/admin/execution");
  return { ok: true, message: "Recorded." };
}

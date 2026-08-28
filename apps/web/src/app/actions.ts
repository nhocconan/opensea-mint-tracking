"use server";

import { AUTO_MINT_POLICY_SETTING_KEY, isAppError, parseAutoMintPolicy } from "@hoodmint/core";
import {
  activateSigner,
  alertChannels,
  armMintPlan,
  cancelOpenPlansForWallet,
  clearPresignedForWallet,
  clearWalletSigningKey,
  consumeBootstrapToken,
  createCredential,
  createMintPlan as createMintPlanRepo,
  createRpcEndpoint,
  createSigner as createSignerRepo,
  createWallet as createWalletRepo,
  type Db,
  deleteAlertChannel,
  deleteMintPlan,
  deleteRpcEndpoint,
  deleteWallet,
  disarmMintPlan,
  ensureProvider,
  findCredentialByType,
  findProjectByContractAddress,
  findProjectBySlugOrId,
  getCredentialSecret,
  getDropStage,
  getMintPlan,
  getSigner,
  listWallets,
  markAuthRequiredChecksDue,
  markExecutionAttemptBroadcast,
  markProviderHealth,
  recordAudit,
  revokeCredential,
  revokeSigner as revokeSignerRepo,
  scrubKeyTracesForAddress,
  setAlertChannelEnabled,
  setRpcEndpointEnabled,
  setSetting,
  setSignerDelegateContract,
  setSignerOnchainCeiling,
  setWalletSigningKey,
  sql,
  toggleWatch,
  unwrapRows,
  updateCredentialSecret,
  updateProvider,
  updateWallet,
  user as userTable,
  wallets as walletsTable,
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
  pollDeviceToken,
  requestDeviceAuthorization,
  resolveXaiClient,
  storedDevicePendingSchema,
  xaiOAuthClientSchema,
} from "@hoodmint/providers";
import { enqueueDetail, enqueueMaintenance, enqueueRarity, queues } from "@hoodmint/queues";
import { fingerprint, sealSecret } from "@hoodmint/secrets";
import { generateSessionKey, managedKeyAddress, parseBrowserSignResult } from "@hoodmint/signing";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isUuid } from "@/lib/admin-validation.ts";
import { container } from "@/lib/container.ts";
import { gmt7LocalToUtc, parseMintTarget } from "@/lib/mint-target.ts";
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

/**
 * Track a specific OpenSea drop by URL or slug (operator+). Discovery only
 * sees OpenSea's curated /drops LIST feed, so a mintable collection that
 * isn't in that list (many direct/non-curated drops) never appears. This
 * fetches it by slug directly (worker runDetailRefresh → getDrop → upsert
 * project + stages), so it shows up in the calendar/feeds/eligibility.
 */
export async function trackDropAction(input: { input: string }): Promise<ActionState> {
  const { db, config } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("scans:run");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const raw = input.input.trim();
  // Accept a full OpenSea URL (…/collection/<slug>[/…]) or a bare slug.
  const urlMatch = raw.match(/opensea\.io\/(?:[a-z]{2}\/)?collection\/([^/?#\s]+)/i);
  const slug = (urlMatch?.[1] ?? raw).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) {
    return {
      ok: false,
      message: "Paste an OpenSea collection URL or a valid collection slug.",
    };
  }
  await enqueueDetail(config.VALKEY_URL, { slug, freshnessBucket: "hot" });
  await recordAudit(db, {
    actorUserId: actor,
    action: "discovery.track_drop",
    targetType: "project",
    targetId: slug,
    result: "success",
    metadata: { slug },
  });
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: `Fetching "${slug}" from OpenSea — reload the calendar/feeds in ~30s. If it never appears it isn't an OpenSea drop (check the slug or the on-chain radar).`,
  };
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
    { jobId: `discover.manual.${Date.now()}` },
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

/** Bulk-add wallets, one per line as `0xADDRESS` or `0xADDRESS,label`
 *  (operator+). Fails closed: any invalid line rejects the whole batch,
 *  nothing partial gets written. `createWalletRepo` upserts on address
 *  (onConflictDoUpdate), so duplicate lines/re-submits are safe. */
export async function createWalletsBulkAction(input: { entries: string }): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("wallets:manage");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const lines = input.entries
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) {
    return { ok: false, message: "Enter at least one wallet, one per line." };
  }
  if (lines.length > 100) {
    return { ok: false, message: `Too many lines (${lines.length}) — max 100 per submit.` };
  }
  const parsed: { address: string; label?: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const commaIndex = line.indexOf(",");
    const addressRaw = commaIndex === -1 ? line : line.slice(0, commaIndex);
    const labelRaw = commaIndex === -1 ? "" : line.slice(commaIndex + 1).trim();
    const address = addressRaw.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      return {
        ok: false,
        message: `Line ${i + 1} is not a valid address ("${line}") — batch rejected, nothing added.`,
      };
    }
    parsed.push({ address, ...(labelRaw !== "" ? { label: labelRaw } : {}) });
  }
  for (const entry of parsed) {
    await createWalletRepo(db, entry);
  }
  await recordAudit(db, {
    actorUserId: actor,
    action: "wallet.bulk_create",
    targetType: "wallet",
    result: "success",
    metadata: { count: parsed.length, addresses: parsed.map((p) => p.address) },
  });
  revalidatePath("/admin/wallets");
  return { ok: true, message: `Added/updated ${parsed.length} wallets.` };
}

/**
 * Import a burner wallet's private key for autonomous managed-key minting
 * (owner-authorized custody, 2026-08-28). Gated by `requireFreshStepUp`
 * exactly like arming a mint — importing a spend-capable key is at least as
 * sensitive. The key is AES-256-GCM sealed before it touches Postgres and
 * only ever decrypted in worker memory at fire time; nothing here (or in the
 * audit log) records the key material — only the derived address and a
 * one-way fingerprint.
 */
export async function importWalletKeyAction(input: {
  privateKey: string;
  label?: string;
  walletId?: string;
}): Promise<ActionState> {
  const { db, config } = container();
  let actor: string | null = null;
  try {
    const user = await requireFreshStepUp("execution:configure");
    actor = user.id;
  } catch (error) {
    return {
      ok: false,
      message: isAppError(error)
        ? error.message
        : "Step-up re-authentication (passkey) required to import a signing key.",
    };
  }
  const key = input.privateKey.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(key)) {
    return { ok: false, message: "Invalid private key — expected 0x followed by 64 hex chars." };
  }
  let address: string;
  try {
    address = managedKeyAddress(key).toLowerCase();
  } catch {
    return { ok: false, message: "Could not derive an address from that key." };
  }
  // Upsert the wallet at the key's own address; a provided walletId must
  // refer to that same wallet (fail closed on any mismatch).
  const wallet = await createWalletRepo(db, {
    address,
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
  });
  if (wallet === undefined) {
    return { ok: false, message: "Failed to persist the wallet." };
  }
  if (input.walletId !== undefined && input.walletId !== "" && input.walletId !== wallet.id) {
    return {
      ok: false,
      message: "This key does not match the selected wallet's address.",
    };
  }
  const sealedJson = JSON.stringify(sealSecret(key, config.APP_ENCRYPTION_KEY));
  await setWalletSigningKey(db, wallet.id, sealedJson, fingerprint(key));
  await recordAudit(db, {
    actorUserId: actor,
    action: "wallet.key_import",
    targetType: "wallet",
    targetId: address,
    result: "success",
    // Address only (public). No key-derived value — not even a fingerprint —
    // so revoking/deleting the wallet leaves nothing key-related behind.
    metadata: { address },
  });
  revalidatePath("/admin/wallets");
  return { ok: true, message: "Signing key imported and encrypted. Wallet is now managed." };
}

/** Remove a managed signing key from a wallet (owner-authorized). */
export async function revokeWalletKeyAction(walletId: string): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("wallets:manage");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  if (!/^[0-9a-f-]{36}$/i.test(walletId)) {
    return { ok: false, message: "Invalid wallet." };
  }
  const [walletRow] = await db
    .select({ address: walletsTable.address })
    .from(walletsTable)
    .where(eq(walletsTable.id, walletId))
    .limit(1);
  const cleared = await clearWalletSigningKey(db, walletId);
  if (!cleared) {
    return { ok: false, message: "Wallet not found." };
  }
  // No-trace hygiene: purge any pre-signed (spend-capable) blobs on this
  // wallet's plans and scrub key-derived values from its audit rows.
  await clearPresignedForWallet(db, walletId);
  if (walletRow !== undefined) {
    await scrubKeyTracesForAddress(db, walletRow.address);
  }
  await recordAudit(db, {
    actorUserId: actor,
    action: "wallet.key_revoke",
    targetType: "wallet",
    targetId: walletId,
    result: "success",
  });
  revalidatePath("/admin/wallets");
  return { ok: true, message: "Signing key removed. Wallet is no longer managed." };
}

/**
 * Update a tracked wallet's label and/or enabled flag (operator+). Never
 * touches the managed signing key — that flows only through the step-up-gated
 * import/revoke actions above. `enabled = false` keeps the address on file
 * (and its managed key, if any) but drops it from eligibility scans.
 */
export async function updateWalletAction(input: {
  id: string;
  label?: string;
  enabled?: boolean;
}): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("wallets:manage");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  if (!isUuid(input.id)) {
    return { ok: false, message: "Invalid wallet." };
  }
  const patch: { label?: string; enabled?: boolean } = {};
  if (input.label !== undefined) {
    patch.label = input.label.trim();
  }
  if (input.enabled !== undefined) {
    patch.enabled = input.enabled;
  }
  if (patch.label === undefined && patch.enabled === undefined) {
    return { ok: false, message: "Nothing to update." };
  }
  const updated = await updateWallet(db, input.id, patch);
  if (updated === undefined) {
    return { ok: false, message: "Wallet not found." };
  }
  await recordAudit(db, {
    actorUserId: actor,
    action: "wallet.update",
    targetType: "wallet",
    targetId: updated.address,
    result: "success",
    metadata: patch,
  });
  revalidatePath("/admin/wallets");
  return { ok: true, message: "Wallet updated." };
}

/**
 * Permanently delete a tracked wallet (operator+). If the wallet holds a
 * managed encrypted signing key, that ciphertext is destroyed with the row —
 * the confirm dialog spells this out and requires typing the address.
 */
export async function deleteWalletAction(id: string): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("wallets:manage");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  if (!isUuid(id)) {
    return { ok: false, message: "Invalid wallet." };
  }
  // No-trace hygiene BEFORE the row goes (plans keep a null wallet_id after
  // delete, so their pre-signed blobs must be purged now, and nothing on a
  // deleted wallet may ever fire): purge pre-signed txs, cancel open plans,
  // scrub key-derived audit metadata. The sealed key dies with the row.
  const [walletRow] = await db
    .select({ address: walletsTable.address })
    .from(walletsTable)
    .where(eq(walletsTable.id, id))
    .limit(1);
  await clearPresignedForWallet(db, id);
  await cancelOpenPlansForWallet(db, id);
  if (walletRow !== undefined) {
    await scrubKeyTracesForAddress(db, walletRow.address);
  }
  const deleted = await deleteWallet(db, id);
  if (!deleted) {
    return { ok: false, message: "Wallet not found." };
  }
  await recordAudit(db, {
    actorUserId: actor,
    action: "wallet.delete",
    targetType: "wallet",
    targetId: id,
    result: "success",
  });
  revalidatePath("/admin/wallets");
  return { ok: true, message: "Wallet deleted." };
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
  // Saving a wallet PAT is what unlocks eligibility — make the checks that
  // were degraded to AUTH_REQUIRED (for lack of a PAT) due now, so the next
  // eligibility pass (≤60s) re-runs them instead of waiting out the 30-minute
  // backoff. Best-effort; never blocks the save.
  let rechecked = 0;
  if (input.type === "opensea_pat") {
    rechecked = await markAuthRequiredChecksDue(db).catch(() => 0);
    revalidatePath("/", "layout");
  }
  revalidatePath("/admin/opensea");
  return {
    ok: true,
    message:
      input.type === "opensea_pat"
        ? `Saved and encrypted. Re-checking ${rechecked} eligibility verdict${rechecked === 1 ? "" : "s"} now — reload feeds in ~1 min.`
        : "Saved and encrypted. Older keys of this type remain until revoked.",
  };
}

/**
 * Force every AUTH_REQUIRED eligibility verdict to recheck now (operator
 * self-service, admin-crud-standards: an operation needed a second time is a
 * button, not a wait). The worker's 60s pass drains them at 15/cycle, so all
 * verdicts refresh within a couple of minutes instead of waiting out the
 * staggered 30-minute backoff.
 */
export async function recheckEligibilityAction(): Promise<ActionState> {
  const { db } = container();
  try {
    await requireApi("credentials:manage");
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const count = await markAuthRequiredChecksDue(db).catch(() => 0);
  revalidatePath("/", "layout");
  return {
    ok: true,
    message:
      count === 0
        ? "No pending 'AUTH NEEDED' verdicts to recheck."
        : `Re-checking ${count} verdict${count === 1 ? "" : "s"} now — reload feeds in ~1–2 min.`,
  };
}

/**
 * Save the auto-mint policy (owner ask 2026-08-28). Enabling autonomous
 * minting on managed wallets is spend-capable → passkey step-up, like arming.
 * The saving admin becomes the policy owner: the worker arms plans on their
 * behalf (armedBy + audit actor).
 */
export async function saveAutoMintPolicyAction(input: unknown): Promise<ActionState> {
  const { db } = container();
  let actor: string;
  try {
    actor = (await requireFreshStepUp("execution:configure")).id;
  } catch (error) {
    return {
      ok: false,
      message: isAppError(error) ? error.message : "Step-up re-authentication required.",
    };
  }
  const policy = parseAutoMintPolicy({ ...(input as Record<string, unknown>), ownerUserId: actor });
  if (policy.enabled && policy.walletIds.length === 0) {
    return { ok: false, message: "Select at least one managed wallet to enable the policy." };
  }
  await setSetting(db, AUTO_MINT_POLICY_SETTING_KEY, policy);
  await recordAudit(db, {
    actorUserId: actor,
    action: "automint.policy_saved",
    targetType: "system",
    result: "success",
    metadata: { ...policy },
  });
  revalidatePath("/admin/execution");
  return {
    ok: true,
    message: policy.enabled
      ? `Auto-mint ENABLED on ${policy.walletIds.length} wallet(s) — planner runs every 60s.`
      : "Auto-mint policy saved (disabled).",
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
  revalidatePath("/admin/signals");
  return { ok: revoked, message: revoked ? "Credential revoked." : "Credential not found." };
}

/* ── xAI (Grok) hype signals (ADR 0007) ──────────────────────────────────── */

/**
 * Store an OPTIONAL override of the built-in public Grok-CLI client id and
 * endpoints. Nothing here is a secret (a device-code public client has no
 * client_secret), but it is sealed like every other credential so there is
 * exactly one storage path, and the client id is mirrored into non-secret
 * metadata for display. Operators using their X subscription never need
 * this — it exists so a private client can be dropped in without a code
 * change.
 */
export async function saveXaiOAuthClientAction(input: {
  clientId: string;
  deviceAuthorizationUrl?: string;
  tokenUrl?: string;
  apiUrl?: string;
}): Promise<ActionState> {
  const { db, config } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("credentials:manage");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const clientId = input.clientId.trim();
  if (clientId.length < 8) {
    return { ok: false, message: "Client ID looks too short to be valid." };
  }
  const endpoints: Record<string, string> = {};
  for (const [key, raw] of [
    ["deviceAuthorization", input.deviceAuthorizationUrl],
    ["token", input.tokenUrl],
    ["api", input.apiUrl],
  ] as const) {
    const value = (raw ?? "").trim();
    if (value === "") {
      continue;
    }
    if (!value.startsWith("https://")) {
      return { ok: false, message: `${key} endpoint must be an https:// URL.` };
    }
    endpoints[key] = value;
  }

  const parsed = xaiOAuthClientSchema.safeParse({
    client_id: clientId,
    ...(Object.keys(endpoints).length > 0 ? { endpoints } : {}),
  });
  if (!parsed.success) {
    return { ok: false, message: "Client override is not valid." };
  }
  await createCredential(db, {
    type: "xai_oauth_client",
    name: "xAI OAuth client override",
    secret: JSON.stringify(parsed.data),
    masterKey: config.APP_ENCRYPTION_KEY,
    metadata: { clientId, endpoints },
    createdBy: actor ?? undefined,
  });
  await recordAudit(db, {
    actorUserId: actor,
    action: "credential.create",
    targetType: "credential",
    targetId: "xai_oauth_client",
    metadata: { type: "xai_oauth_client" },
    result: "success",
  });
  revalidatePath("/admin/signals");
  return { ok: true, message: "Saved. Reconnect the account for it to take effect." };
}

/** Store a console.x.ai API key, encrypted at rest (admin only). */
export async function saveXaiApiKeyAction(input: { value: string }): Promise<ActionState> {
  const { db, config } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("credentials:manage");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const value = input.value.trim();
  if (value.length < 16) {
    return { ok: false, message: "Value looks too short to be an xAI API key." };
  }
  await createCredential(db, {
    type: "xai_api_key",
    name: "xAI API key",
    secret: value,
    masterKey: config.APP_ENCRYPTION_KEY,
    createdBy: actor ?? undefined,
  });
  await recordAudit(db, {
    actorUserId: actor,
    action: "credential.create",
    targetType: "credential",
    targetId: "xai_api_key",
    metadata: { type: "xai_api_key" },
    result: "success",
  });
  revalidatePath("/admin/signals");
  return { ok: true, message: "Saved and encrypted. Older keys remain until revoked." };
}

/** What the browser is allowed to see about an in-flight device grant. */
export interface XaiDeviceAuthState {
  readonly ok: boolean;
  readonly message: string;
  /** Short code the operator types at x.ai. Not a credential by itself. */
  readonly userCode?: string;
  readonly verificationUri?: string;
  readonly verificationUriComplete?: string;
  readonly intervalSeconds?: number;
  readonly expiresAt?: string;
}

/**
 * Begin the RFC 8628 device grant.
 *
 * The `device_code` is bearer-equivalent — anyone holding it can complete
 * the grant — so it is sealed into a short-lived `xai_device_pending`
 * credential and NEVER returned to the browser. That reuses the existing
 * AES-256-GCM credential path (no schema change, no new table, and
 * `revokeCredential` is already the "clear it" primitive) instead of a
 * cookie, which would put the code in a client-readable round trip, or a
 * file, which the read-only worker/web FS forbids. The row is bound to the
 * initiating admin via `createdBy` + `metadata.userId` and is deleted the
 * moment the poll reaches a terminal state.
 */
export async function startXaiDeviceAuthAction(): Promise<XaiDeviceAuthState> {
  const { db, config } = container();
  let actor: string;
  try {
    const user = await requireApi("credentials:manage");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }

  try {
    const client = await resolveStoredXaiClient(db, config.APP_ENCRYPTION_KEY);
    const device = await requestDeviceAuthorization({ client });
    const expiresAt = new Date(Date.now() + device.expires_in * 1000);

    // Only one grant may be in flight; drop any stale pending row first.
    const stale = await findCredentialByType(db, "xai_device_pending");
    if (stale !== undefined) {
      await revokeCredential(db, stale.id);
    }
    await createCredential(db, {
      type: "xai_device_pending",
      name: "xAI device grant (pending)",
      secret: JSON.stringify({
        device_code: device.device_code,
        interval: device.interval,
        expires_at: expiresAt.toISOString(),
      }),
      masterKey: config.APP_ENCRYPTION_KEY,
      // Non-secret only: never the device_code.
      metadata: { userId: actor, interval: device.interval },
      expiresAt,
      createdBy: actor,
    });
    await recordAudit(db, {
      actorUserId: actor,
      action: "credential.xai_device_start",
      targetType: "credential",
      targetId: "xai_user_token",
      result: "success",
    });

    return {
      ok: true,
      message: "Approve the code at x.ai, then this page will finish automatically.",
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      ...(device.verification_uri_complete !== undefined
        ? { verificationUriComplete: device.verification_uri_complete }
        : {}),
      intervalSeconds: device.interval,
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      message: isAppError(error)
        ? `Could not start the connection: ${error.message}`
        : "Could not reach xAI to start the connection.",
    };
  }
}

export interface XaiDevicePollState {
  readonly status: "pending" | "slow_down" | "denied" | "expired" | "success" | "error";
  readonly message: string;
  /** Seconds the client should wait before polling again. */
  readonly intervalSeconds?: number;
}

/**
 * Poll the token endpoint once for the in-flight grant. On success the
 * tokens are sealed into `xai_user_token` and the pending row is deleted;
 * on any terminal failure the pending row is deleted too, so a stuck grant
 * can always be restarted.
 */
export async function pollXaiDeviceAuthAction(): Promise<XaiDevicePollState> {
  const { db, config } = container();
  let actor: string;
  try {
    const user = await requireApi("credentials:manage");
    actor = user.id;
  } catch {
    return { status: "error", message: "Insufficient role." };
  }

  const pending = await findCredentialByType(db, "xai_device_pending");
  if (pending === undefined) {
    return { status: "error", message: "No connection in progress. Start it again." };
  }
  // Bind the grant to the admin who started it: another admin polling would
  // otherwise attach the first admin's subscription without their action.
  if (pending.metadata?.userId !== actor) {
    return { status: "error", message: "This connection was started by another admin." };
  }
  const sealed = await getCredentialSecret(db, pending.id, config.APP_ENCRYPTION_KEY);
  const parsed = storedDevicePendingSchema.safeParse(
    sealed === undefined ? null : safeParseJson(sealed),
  );
  if (!parsed.success) {
    await revokeCredential(db, pending.id);
    return { status: "error", message: "Pending connection was unreadable. Start it again." };
  }
  if (Date.parse(parsed.data.expires_at) <= Date.now()) {
    await revokeCredential(db, pending.id);
    return { status: "expired", message: "The code expired before it was approved. Try again." };
  }

  let outcome: Awaited<ReturnType<typeof pollDeviceToken>>;
  try {
    const client = await resolveStoredXaiClient(db, config.APP_ENCRYPTION_KEY);
    outcome = await pollDeviceToken({
      client,
      deviceCode: parsed.data.device_code,
      intervalSeconds: parsed.data.interval,
    });
  } catch {
    // Transport failure is not terminal — keep the grant alive and retry.
    return {
      status: "pending",
      message: "Waiting for approval…",
      intervalSeconds: parsed.data.interval,
    };
  }

  switch (outcome.status) {
    case "pending":
      return {
        status: "pending",
        message: "Waiting for approval at x.ai…",
        intervalSeconds: outcome.intervalSeconds,
      };
    case "slow_down":
      return {
        status: "slow_down",
        message: "Waiting for approval at x.ai…",
        intervalSeconds: outcome.intervalSeconds,
      };
    case "denied":
      await revokeCredential(db, pending.id);
      await recordAudit(db, {
        actorUserId: actor,
        action: "credential.xai_device_connect",
        targetType: "credential",
        targetId: "xai_user_token",
        result: "failure",
        metadata: { reason: "access_denied" },
      });
      revalidatePath("/admin/signals");
      return { status: "denied", message: "Approval was declined at x.ai — nothing was stored." };
    case "expired":
      await revokeCredential(db, pending.id);
      revalidatePath("/admin/signals");
      return { status: "expired", message: "The code expired before it was approved. Try again." };
    case "error":
      await revokeCredential(db, pending.id);
      revalidatePath("/admin/signals");
      return { status: "error", message: `xAI rejected the connection (${outcome.code}).` };
    case "success": {
      const token = outcome.token;
      const metadata = {
        scopes: token.scopes,
        health: "healthy",
        lastErrorCode: null,
        connectedAt: new Date().toISOString(),
      };
      // Rotate an existing connection in place so the worker never sees two
      // live subscription tokens and the row id stays stable.
      const existing = await findCredentialByType(db, "xai_user_token");
      if (existing === undefined) {
        await createCredential(db, {
          type: "xai_user_token",
          name: "xAI subscription (Grok) token",
          secret: JSON.stringify(token),
          masterKey: config.APP_ENCRYPTION_KEY,
          metadata,
          expiresAt: new Date(token.expires_at),
          createdBy: actor,
        });
      } else {
        await updateCredentialSecret(db, existing.id, {
          secret: JSON.stringify(token),
          masterKey: config.APP_ENCRYPTION_KEY,
          metadata,
          expiresAt: new Date(token.expires_at),
        });
      }
      await revokeCredential(db, pending.id);
      await recordAudit(db, {
        actorUserId: actor,
        action: "credential.xai_device_connect",
        targetType: "credential",
        targetId: "xai_user_token",
        result: "success",
        // Scope names only — no token material (PRD §11).
        metadata: { scopes: token.scopes },
      });
      revalidatePath("/admin/signals");
      return { status: "success", message: "Connected. The next scan will use your subscription." };
    }
  }
}

/** Built-in public client, overridden by `xai_oauth_client` when present. */
async function resolveStoredXaiClient(db: Db, masterKey: string) {
  const credential = await findCredentialByType(db, "xai_oauth_client");
  if (credential === undefined) {
    return resolveXaiClient(null);
  }
  const sealed = await getCredentialSecret(db, credential.id, masterKey);
  if (sealed === undefined) {
    return resolveXaiClient(null);
  }
  const parsed = xaiOAuthClientSchema.safeParse(safeParseJson(sealed));
  return resolveXaiClient(parsed.success ? parsed.data : null);
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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

/** Enable/disable an alert channel without destroying its credential (admin only). */
export async function setAlertChannelEnabledAction(
  id: string,
  enabled: boolean,
): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("alerts:configure");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  if (!isUuid(id)) {
    return { ok: false, message: "Invalid channel." };
  }
  const changed = await setAlertChannelEnabled(db, id, enabled);
  if (!changed) {
    return { ok: false, message: "Channel not found." };
  }
  await recordAudit(db, {
    actorUserId: actor,
    action: "alert_channel.toggle",
    targetType: "alert_channel",
    targetId: id,
    result: "success",
    metadata: { enabled },
  });
  revalidatePath("/admin/alerts");
  return { ok: true, message: enabled ? "Channel enabled." : "Channel disabled." };
}

/**
 * Delete an alert channel and revoke its linked secret (admin only). The
 * channel's encrypted credential (bot token / webhook URL) is revoked in the
 * same action so no orphaned secret is left behind; a `web_push` channel has
 * no separate credential (its subscription lives inline and goes with the row).
 */
export async function deleteAlertChannelAction(id: string): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("alerts:configure");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  if (!isUuid(id)) {
    return { ok: false, message: "Invalid channel." };
  }
  const deleted = await deleteAlertChannel(db, id);
  if (deleted === undefined) {
    return { ok: false, message: "Channel not found." };
  }
  if (deleted.credentialId !== null) {
    await revokeCredential(db, deleted.credentialId);
  }
  await recordAudit(db, {
    actorUserId: actor,
    action: "alert_channel.delete",
    targetType: "alert_channel",
    targetId: id,
    result: "success",
    metadata: { kind: deleted.kind },
  });
  revalidatePath("/admin/alerts");
  return { ok: true, message: "Channel deleted." };
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

/** Creates one mint plan per wallet, all in `draft` status only — arming is
 *  a separate, step-up-gated action below. Fans a single project/stage/
 *  signer/quantity/ceiling config out across many wallets so the operator
 *  can mint with many wallets at once instead of repeating this form. */
export async function createMintPlanAction(input: {
  projectId: string;
  walletIds: string[];
  stageId?: string;
  signerId?: string;
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
  const walletIds = [...new Set(input.walletIds.map((id) => id.trim()))].filter((id) => id !== "");
  if (walletIds.length === 0) {
    return { ok: false, message: "Select at least one wallet." };
  }
  if (walletIds.length > 50) {
    return {
      ok: false,
      message: `Too many wallets selected (${walletIds.length}) — max 50 per submit.`,
    };
  }
  for (const walletId of walletIds) {
    if (!uuid.test(walletId)) {
      return { ok: false, message: "Invalid wallet selection." };
    }
  }
  if (!/^[0-9]+$/.test(input.perPlanCeilingWei) || input.perPlanCeilingWei === "0") {
    return { ok: false, message: "Per-plan ceiling must be a positive wei amount." };
  }
  // Math.max(1, NaN) is NaN, not 1 — an empty/non-numeric quantity field
  // must fail closed with a clear message, not insert a NaN quantity.
  if (!Number.isFinite(input.quantity)) {
    return { ok: false, message: "Quantity must be a number." };
  }
  // Both optional — empty string/undefined means "keep the current default
  // behavior" (coarse 30s tick / browser_wallet fallback), not an error.
  const stageIdRaw = input.stageId?.trim() ?? "";
  let stageId: string | undefined;
  if (stageIdRaw !== "") {
    if (!uuid.test(stageIdRaw)) {
      return { ok: false, message: "Invalid stage selection." };
    }
    const stage = await getDropStage(db, stageIdRaw);
    if (stage === undefined || stage.projectId !== input.projectId) {
      return { ok: false, message: "Selected stage does not belong to the chosen project." };
    }
    stageId = stageIdRaw;
  }
  const signerIdRaw = input.signerId?.trim() ?? "";
  let signerId: string | undefined;
  if (signerIdRaw !== "") {
    if (!uuid.test(signerIdRaw)) {
      return { ok: false, message: "Invalid signer selection." };
    }
    const signer = await getSigner(db, signerIdRaw);
    if (signer === undefined) {
      return { ok: false, message: "Selected signer not found." };
    }
    if (signer.status !== "active") {
      return { ok: false, message: "Selected signer is not active yet." };
    }
    signerId = signerIdRaw;
  }
  // Sequential: each wallet gets its own plan row, same project/stage/
  // signer/quantity/ceiling config, and its own audit entry (matches the
  // existing single-plan audit shape below, which already keys on
  // walletId per row — a batch-level audit would lose that per-wallet
  // targetId).
  const quantity = Math.max(1, Math.floor(input.quantity));
  for (const walletId of walletIds) {
    const created = await createMintPlanRepo(db, {
      projectId: input.projectId,
      walletId,
      ...(stageId !== undefined ? { stageId } : {}),
      ...(signerId !== undefined ? { signerId } : {}),
      quantity,
      perPlanCeilingWei: input.perPlanCeilingWei,
    });
    await recordAudit(db, {
      actorUserId: actor,
      action: "execution.mint_plan.create",
      targetType: "mint_plan",
      targetId: created.id,
      result: "success",
      metadata: {
        projectId: input.projectId,
        walletId,
        stageId: stageId ?? null,
        signerId: signerId ?? null,
      },
    });
  }
  revalidatePath("/admin/execution");
  return {
    ok: true,
    message:
      walletIds.length === 1
        ? "1 mint plan created as draft (not armed)."
        : `${walletIds.length} mint plans created as drafts (not armed).`,
  };
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
 * Delete a DRAFT mint plan (execution:operate). Refuses anything past draft
 * both here and in the repo's WHERE clause — an armed/executing/executed plan
 * is part of the live execution + audit trail and is never deletable. Disarm
 * first, then delete, if a plan is armed.
 */
export async function deleteMintPlanAction(id: string): Promise<ActionState> {
  const { db } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("execution:operate");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  if (!isUuid(id)) {
    return { ok: false, message: "Invalid mint plan." };
  }
  const deleted = await deleteMintPlan(db, id);
  if (!deleted) {
    return { ok: false, message: "Only draft plans can be deleted — disarm it first if armed." };
  }
  await recordAudit(db, {
    actorUserId: actor,
    action: "execution.mint_plan.delete",
    targetType: "mint_plan",
    targetId: id,
    result: "success",
  });
  revalidatePath("/admin/execution");
  return { ok: true, message: "Draft mint plan deleted." };
}

/* ── Admin → Special mints (admin-only sniper console) ───────────────────── */

/** Max plans one Special-mints submit may create, mirroring the 50-wallet
 *  cap `createMintPlanAction` already enforces. */
const SPECIAL_MINT_MAX_WALLETS = 50;
/** Per-wallet quantity ceiling — a slip of the keyboard must not turn a
 *  1-of-1 into a 500-mint spend. */
const SPECIAL_MINT_MAX_QUANTITY = 20;
/** Hard cap on any arm window (PRD §15 / ADR 0008: an arm always expires). */
const SPECIAL_MINT_MAX_ARM_MINUTES = 24 * 60;
/** How long past a manually-typed fire time a plan stays armed. */
const MANUAL_FIRE_ARM_TAIL_MS = 4 * 60 * 60 * 1000;

export interface SpecialMintTargetState extends ActionState {
  /** Set only when the target resolved to a project already in the DB. */
  readonly projectId?: string;
}

/**
 * Resolve what the operator pasted into the Special-mints target box — an
 * OpenSea collection URL, a bare slug, or a raw contract address — to a
 * project already in the DB. When a slug isn't tracked yet it enqueues the
 * same detail fetch `trackDropAction` uses (worker → getDrop → upsert
 * project + stages) and asks the operator to retry; a bare contract address
 * has no slug to fetch by, so that case says so plainly rather than
 * enqueueing a guess.
 */
export async function resolveSpecialMintTargetAction(input: {
  target: string;
}): Promise<SpecialMintTargetState> {
  const { db, config } = container();
  let actor: string | null = null;
  try {
    const user = await requireApi("execution:configure");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  const target = parseMintTarget(input.target);
  if (target === null) {
    return {
      ok: false,
      message:
        "Paste an OpenSea collection URL, a collection slug, or a 0x… contract address (40 hex characters).",
    };
  }
  const project =
    target.kind === "slug"
      ? await findProjectBySlugOrId(db, target.slug)
      : await findProjectByContractAddress(db, target.address);
  if (project !== undefined) {
    await recordAudit(db, {
      actorUserId: actor,
      action: "execution.special_mint.resolve",
      targetType: "project",
      targetId: project.id,
      result: "success",
      metadata: { kind: target.kind },
    });
    return { ok: true, message: `Resolved "${project.name}".`, projectId: project.id };
  }
  if (target.kind === "contract") {
    return {
      ok: false,
      message:
        "That contract isn't tracked yet. Paste the OpenSea collection URL (or its slug) instead — a fetch can only be requested by slug.",
    };
  }
  await enqueueDetail(config.VALKEY_URL, { slug: target.slug, freshnessBucket: "hot" });
  await recordAudit(db, {
    actorUserId: actor,
    action: "execution.special_mint.enqueue_detail",
    targetType: "project",
    targetId: target.slug,
    result: "success",
    metadata: { slug: target.slug },
  });
  return {
    ok: false,
    message: `"${target.slug}" isn't tracked yet — fetching it from OpenSea now. Retry in ~30s. If it never resolves it isn't an OpenSea drop.`,
  };
}

export interface SpecialMintWalletInput {
  readonly walletId: string;
  readonly quantity: number;
}

/**
 * Creates ONE draft plan per selected wallet, each with its own quantity, a
 * shared per-plan spend ceiling, and an optional operator-typed fire instant
 * that overrides the stage start in the worker's precision hot loop
 * (`coalesce(mint_plans.fire_at, drop_stages.starts_at)`).
 *
 * `fireAtGmt7` is the RAW `<input type="datetime-local">` value, and the
 * GMT+7 → UTC conversion happens HERE, server-side. It deliberately is not a
 * pre-converted `fireAtUtc` from the browser: a client-side conversion would
 * silently inherit whatever timezone the operator's laptop happens to be in,
 * and a mis-set laptop clock zone would move a mint by hours with nothing to
 * catch it. Storage is UTC (PRD §14); GMT+7 is a display/entry convention.
 *
 * Fails closed on every branch, is audited per plan, and — like
 * `createMintPlanAction` — creates `draft` rows only. Nothing here can fire;
 * arming is the separate passkey-gated step below.
 */
export async function createSpecialMintAction(input: {
  projectId: string;
  stageId?: string;
  fireAtGmt7?: string;
  wallets: SpecialMintWalletInput[];
  perPlanCeilingWei: string;
}): Promise<ActionState> {
  const { db } = container();
  let actor: string;
  try {
    const user = await requireApi("execution:configure");
    actor = user.id;
  } catch {
    return { ok: false, message: "Insufficient role." };
  }
  if (!isUuid(input.projectId)) {
    return { ok: false, message: "Pick a target collection first." };
  }
  if (!/^[0-9]+$/.test(input.perPlanCeilingWei) || input.perPlanCeilingWei === "0") {
    return { ok: false, message: "Per-plan ceiling must be a positive wei amount." };
  }

  // Stage (optional): must belong to the chosen project.
  const stageIdRaw = input.stageId?.trim() ?? "";
  let stageId: string | undefined;
  if (stageIdRaw !== "") {
    if (!isUuid(stageIdRaw)) {
      return { ok: false, message: "Invalid stage selection." };
    }
    const stage = await getDropStage(db, stageIdRaw);
    if (stage === undefined || stage.projectId !== input.projectId) {
      return { ok: false, message: "Selected stage does not belong to the chosen collection." };
    }
    stageId = stageIdRaw;
  }

  // Manual fire time (optional): GMT+7 in, UTC out.
  const fireAtRaw = input.fireAtGmt7?.trim() ?? "";
  let fireAt: Date | undefined;
  if (fireAtRaw !== "") {
    const converted = gmt7LocalToUtc(fireAtRaw);
    if (converted === null) {
      return { ok: false, message: "Manual fire time must be a real date/time (GMT+7)." };
    }
    fireAt = converted;
  }
  if (stageId === undefined && fireAt === undefined) {
    return {
      ok: false,
      message: "Pick a phase or type a manual fire time — a special mint needs a fire instant.",
    };
  }

  // Wallets: managed (a sealed signing key) and enabled only. A wallet with
  // no key cannot fire autonomously at the open instant, which is the entire
  // point of this console — refuse rather than silently create a plan that
  // will sit waiting for a browser signature nobody is watching for.
  const rawWallets = input.wallets ?? [];
  const seen = new Set<string>();
  const selections: SpecialMintWalletInput[] = [];
  for (const entry of rawWallets) {
    const walletId = entry.walletId.trim();
    if (walletId === "" || seen.has(walletId)) {
      continue;
    }
    if (!isUuid(walletId)) {
      return { ok: false, message: "Invalid wallet selection." };
    }
    if (!Number.isFinite(entry.quantity)) {
      return { ok: false, message: "Every selected wallet needs a numeric quantity." };
    }
    const quantity = Math.floor(entry.quantity);
    if (quantity < 1 || quantity > SPECIAL_MINT_MAX_QUANTITY) {
      return {
        ok: false,
        message: `Quantity must be between 1 and ${SPECIAL_MINT_MAX_QUANTITY} per wallet.`,
      };
    }
    seen.add(walletId);
    selections.push({ walletId, quantity });
  }
  if (selections.length === 0) {
    return { ok: false, message: "Select at least one managed wallet." };
  }
  if (selections.length > SPECIAL_MINT_MAX_WALLETS) {
    return {
      ok: false,
      message: `Too many wallets selected (${selections.length}) — max ${SPECIAL_MINT_MAX_WALLETS} per submit.`,
    };
  }
  const managed = new Set(
    (await listWallets(db, { enabledOnly: true }))
      .filter((w) => w.hasSigningKey)
      .map((w) => w.id),
  );
  const unusable = selections.filter((s) => !managed.has(s.walletId));
  if (unusable.length > 0) {
    return {
      ok: false,
      message: `${unusable.length} selected wallet(s) are not enabled managed wallets — import a minting key on Admin → Wallets first.`,
    };
  }

  const createdIds: string[] = [];
  for (const selection of selections) {
    const created = await createMintPlanRepo(db, {
      projectId: input.projectId,
      walletId: selection.walletId,
      ...(stageId !== undefined ? { stageId } : {}),
      ...(fireAt !== undefined ? { fireAt } : {}),
      quantity: selection.quantity,
      perPlanCeilingWei: input.perPlanCeilingWei,
    });
    createdIds.push(created.id);
    await recordAudit(db, {
      actorUserId: actor,
      action: "execution.special_mint.create",
      targetType: "mint_plan",
      targetId: created.id,
      result: "success",
      metadata: {
        projectId: input.projectId,
        walletId: selection.walletId,
        stageId: stageId ?? null,
        quantity: selection.quantity,
        fireAt: fireAt?.toISOString() ?? null,
        perPlanCeilingWei: input.perPlanCeilingWei,
      },
    });
  }
  revalidatePath("/admin/special-mints");
  revalidatePath("/admin/execution");
  return {
    ok: true,
    message: `${createdIds.length} draft plan${createdIds.length === 1 ? "" : "s"} created${
      fireAt === undefined ? " (fire time auto-detected from the phase)" : " with a manual fire time"
    }. Not armed yet.`,
  };
}

/**
 * Compute a plan's arm window from the plan's OWN timing, never from a
 * client-supplied number: until the stage ends (capped at 24h) for an
 * auto-detected phase, or the manual fire instant plus a 4h tail. Returns
 * null when the plan has no future fire instant left at all.
 */
function specialMintArmMinutes(
  now: number,
  plan: { fireAt: Date | string | null },
  stage: { startsAt: Date | string; endsAt: Date | string | null } | undefined,
): number | null {
  const ms = (value: Date | string): number =>
    (value instanceof Date ? value : new Date(value)).getTime();
  let untilMs: number;
  if (plan.fireAt !== null) {
    // An override wins over the stage everywhere, including here.
    untilMs = ms(plan.fireAt) + MANUAL_FIRE_ARM_TAIL_MS;
  } else if (stage === undefined) {
    return null;
  } else if (stage.endsAt !== null) {
    untilMs = ms(stage.endsAt);
  } else {
    untilMs = ms(stage.startsAt) + MANUAL_FIRE_ARM_TAIL_MS;
  }
  const minutes = Math.ceil((untilMs - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) {
    return null;
  }
  return Math.min(minutes, SPECIAL_MINT_MAX_ARM_MINUTES);
}

export interface SpecialMintArmResult {
  readonly planId: string;
  readonly ok: boolean;
  readonly message: string;
}

export interface SpecialMintArmState extends ActionState {
  readonly results: SpecialMintArmResult[];
}

/**
 * Arm every draft plan of one special mint from a SINGLE passkey ceremony.
 * The step-up is re-verified server-side here (`requireFreshStepUp` — the
 * same gate `armMintPlanAction` uses, not a weaker one) and is valid for two
 * minutes, which is why arming the batch sequentially in one call is safe:
 * the proof is checked once, up front, for the whole batch, and every plan
 * still goes through the same `armMintPlan` draft-only transition.
 *
 * The per-plan window is derived server-side from the plan's own stage /
 * fire_at; nothing about the window is taken from the client.
 */
export async function armSpecialMintPlansAction(planIds: string[]): Promise<SpecialMintArmState> {
  const { db } = container();
  let actor: string;
  try {
    const user = await requireFreshStepUp("execution:configure");
    actor = user.id;
  } catch (error) {
    return {
      ok: false,
      message: isAppError(error) ? error.message : "Step-up re-authentication required.",
      results: [],
    };
  }
  const ids = [...new Set(planIds.map((id) => id.trim()))].filter((id) => id !== "");
  if (ids.length === 0) {
    return { ok: false, message: "No draft plans to arm.", results: [] };
  }
  if (ids.length > SPECIAL_MINT_MAX_WALLETS) {
    return {
      ok: false,
      message: `Too many plans in one arm (${ids.length}) — max ${SPECIAL_MINT_MAX_WALLETS}.`,
      results: [],
    };
  }
  const now = Date.now();
  const results: SpecialMintArmResult[] = [];
  for (const planId of ids) {
    if (!isUuid(planId)) {
      results.push({ planId, ok: false, message: "Invalid plan id." });
      continue;
    }
    const plan = await getMintPlan(db, planId);
    if (plan === undefined) {
      results.push({ planId, ok: false, message: "Plan not found." });
      continue;
    }
    const stage = plan.stageId === null ? undefined : await getDropStage(db, plan.stageId);
    const windowMinutes = specialMintArmMinutes(now, plan, stage);
    if (windowMinutes === null) {
      results.push({
        planId,
        ok: false,
        message: "Fire time has already passed — create a fresh plan.",
      });
      await recordAudit(db, {
        actorUserId: actor,
        action: "execution.special_mint.arm",
        targetType: "mint_plan",
        targetId: planId,
        result: "failure",
        metadata: { reason: "fire_time_passed" },
      });
      continue;
    }
    const armed = await armMintPlan(db, planId, actor, windowMinutes);
    if (armed === undefined) {
      results.push({ planId, ok: false, message: "Not in draft status — nothing to arm." });
      continue;
    }
    await recordAudit(db, {
      actorUserId: actor,
      action: "execution.special_mint.arm",
      targetType: "mint_plan",
      targetId: planId,
      result: "success",
      metadata: { windowMinutes },
    });
    results.push({ planId, ok: true, message: `Armed for ${windowMinutes} min.` });
  }
  const armedCount = results.filter((r) => r.ok).length;
  revalidatePath("/admin/special-mints");
  revalidatePath("/admin/execution");
  return {
    ok: armedCount > 0,
    message: `${armedCount} of ${results.length} plan(s) armed.`,
    results,
  };
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

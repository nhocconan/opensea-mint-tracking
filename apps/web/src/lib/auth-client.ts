/**
 * Shared Better Auth client (ADR 0008). `passkeyClient()` adds
 * `authClient.passkey.addPasskey()` (registration) and
 * `authClient.signIn.passkey()` (the WebAuthn ceremony the step-up gate
 * requires before arming) on top of the base email/password client already
 * used by the login form.
 *
 * `adminClient()` mirrors the server-side `admin()` plugin (packages/auth)
 * and exposes `authClient.admin.*`. The method names are derived from the
 * plugin's endpoint paths (verified against the installed
 * better-auth@1.6.29 dist): `/admin/create-user` → `createUser`,
 * `/admin/set-role` → `setRole`, `/admin/ban-user` → `banUser`,
 * `/admin/unban-user` → `unbanUser`, `/admin/remove-user` → `removeUser`,
 * `/admin/list-users` → `listUsers`. Authorization is still enforced
 * server-side (adminRole: "admin") — the client is only the transport.
 */
import { passkeyClient } from "@better-auth/passkey/client";
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [passkeyClient(), adminClient()],
});

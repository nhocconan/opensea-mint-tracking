/**
 * Shared Better Auth client (ADR 0008). `passkeyClient()` adds
 * `authClient.passkey.addPasskey()` (registration) and
 * `authClient.signIn.passkey()` (the WebAuthn ceremony the step-up gate
 * requires before arming) on top of the base email/password client already
 * used by the login form.
 */
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [passkeyClient()],
});

"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog.tsx";
import { ADMIN_ROLES, type AdminRole, validateNewUser } from "@/lib/admin-validation.ts";
import { authClient } from "@/lib/auth-client.ts";

/**
 * Client CRUD for users on top of the Better Auth admin plugin
 * (`authClient.admin.*`). Every method name/argument shape is verified
 * against better-auth@1.6.29's admin dist:
 *   createUser({ email, password, name, role })
 *   setRole({ userId, role })
 *   banUser({ userId, banReason }) / unbanUser({ userId })
 *   removeUser({ userId })
 * Authorization is enforced server-side (adminRole: "admin"); these calls
 * only fail-open into an error message, never a silent no-op.
 */

/** The subset of a better-auth client result we read (loosely typed so it
 *  accepts the full `{ data, error }` shape either method branch returns). */
type AuthResult = { error?: { message?: string | undefined } | null };

/** Turn a better-auth `{ error }` object into a human message. */
function errorMessage(
  error: { message?: string | undefined } | null | undefined,
  fallback: string,
): string {
  return error?.message !== undefined && error.message !== "" ? error.message : fallback;
}

/**
 * The app's roles (viewer/operator/admin) are stored as free-form strings
 * server-side, but the Better Auth admin plugin's *types* only know its
 * built-in `admin`/`user` roles (we never configured a client-side `roles`
 * access controller). This cast passes the real app role through to the
 * runtime, which accepts any string — the server RBAC is the real gate.
 */
function asAuthRole(role: string): "admin" {
  return role as "admin";
}

export function CreateUserForm() {
  const router = useRouter();
  const baseId = useId();
  const [role, setRole] = useState<AdminRole>("viewer");
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(formData: FormData) {
    const input = {
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      name: String(formData.get("name") ?? ""),
      role,
    };
    const valid = validateNewUser(input);
    if (!valid.ok) {
      setStatus({ ok: false, message: valid.message });
      return;
    }
    startTransition(async () => {
      setStatus(null);
      const { error } = await authClient.admin.createUser({
        email: input.email.trim().toLowerCase(),
        password: input.password,
        name: input.name.trim(),
        role: asAuthRole(input.role),
      });
      if (error) {
        setStatus({ ok: false, message: errorMessage(error, "Could not create user.") });
        return;
      }
      setStatus({ ok: true, message: "User created." });
      router.refresh();
    });
  }

  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        Create user
      </h2>
      <form action={onSubmit} className="mt-3 space-y-2">
        <div>
          <label htmlFor={`${baseId}-name`} className="block text-[11px] text-ink-muted">
            Name
          </label>
          <input
            id={`${baseId}-name`}
            name="name"
            required
            autoComplete="off"
            className="mt-1 w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
          />
        </div>
        <div>
          <label htmlFor={`${baseId}-email`} className="block text-[11px] text-ink-muted">
            Email
          </label>
          <input
            id={`${baseId}-email`}
            name="email"
            type="email"
            required
            autoComplete="off"
            className="mt-1 w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
          />
        </div>
        <div>
          <label htmlFor={`${baseId}-password`} className="block text-[11px] text-ink-muted">
            Password (min 12 characters)
          </label>
          <input
            id={`${baseId}-password`}
            name="password"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            className="mt-1 w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
          />
        </div>
        <div>
          <label htmlFor={`${baseId}-role`} className="block text-[11px] text-ink-muted">
            Role
          </label>
          <select
            id={`${baseId}-role`}
            value={role}
            onChange={(e) => setRole(e.target.value as AdminRole)}
            className="mt-1 w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
          >
            {ADMIN_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create user"}
        </button>
        {status !== null ? (
          <p
            role={status.ok ? "status" : "alert"}
            className={`text-xs ${status.ok ? "text-acid" : "text-magenta"}`}
          >
            {status.message}
          </p>
        ) : null}
      </form>
    </section>
  );
}

export function UserRowActions({
  userId,
  email,
  role,
  banned,
  isSelf,
}: {
  userId: string;
  email: string;
  role: string;
  banned: boolean;
  isSelf: boolean;
}) {
  const router = useRouter();
  const selectId = useId();
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<AuthResult>, fallback: string) {
    startTransition(async () => {
      setStatus(null);
      const { error } = await fn();
      if (error) {
        setStatus({ ok: false, message: errorMessage(error, fallback) });
        return;
      }
      router.refresh();
    });
  }

  // Self-row: no ban/remove (can't lock yourself out), and role is read-only
  // so a mis-click can't demote yourself out of admin.
  if (isSelf) {
    return <span className="text-[11px] text-ink-faint">you</span>;
  }

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <label htmlFor={selectId} className="sr-only">
        Set role for {email}
      </label>
      <select
        id={selectId}
        defaultValue={role}
        disabled={pending}
        onChange={(e) =>
          run(
            () => authClient.admin.setRole({ userId, role: asAuthRole(e.target.value) }),
            "Could not set role.",
          )
        }
        className="rounded-xs border border-line bg-base px-1.5 py-0.5 font-mono text-[11px] disabled:opacity-50"
      >
        {ADMIN_ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>

      {banned ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => authClient.admin.unbanUser({ userId }), "Could not unban user.")}
          className="rounded-xs border border-acid/40 px-2 py-0.5 text-[11px] text-acid hover:bg-acid/10 disabled:opacity-50"
        >
          {pending ? "…" : "Unban"}
        </button>
      ) : (
        <BanControl userId={userId} email={email} disabled={pending} onRun={run} />
      )}

      <ConfirmDialog
        triggerLabel="Remove"
        triggerAriaLabel={`Remove user ${email}`}
        title="Remove user"
        confirmLabel="Remove user"
        requireTyping={email}
        consequence={
          <p>
            This permanently deletes the account <span className="font-mono text-ink">{email}</span>{" "}
            and its sessions. This cannot be undone.
          </p>
        }
        onConfirm={async () => {
          const { error } = await authClient.admin.removeUser({ userId });
          if (error) {
            return { ok: false, message: errorMessage(error, "Could not remove user.") };
          }
          router.refresh();
          return { ok: true, message: "" };
        }}
      />

      {status !== null && !status.ok ? (
        <span role="alert" className="text-[11px] text-magenta">
          {status.message}
        </span>
      ) : null}
    </span>
  );
}

/** Ban with an optional reason, captured in a small popover-less inline form. */
function BanControl({
  userId,
  email,
  disabled,
  onRun,
}: {
  userId: string;
  email: string;
  disabled: boolean;
  onRun: (fn: () => Promise<AuthResult>, fallback: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const inputId = useId();

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="rounded-xs border border-magenta/40 px-2 py-0.5 text-[11px] text-magenta hover:bg-magenta/10 disabled:opacity-50"
      >
        Ban
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <label htmlFor={inputId} className="sr-only">
        Ban reason for {email}
      </label>
      <input
        id={inputId}
        value={reason}
        placeholder="reason (optional)"
        maxLength={200}
        onChange={(e) => setReason(e.target.value)}
        className="w-32 rounded-xs border border-line bg-base px-1.5 py-0.5 font-mono text-[11px]"
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          onRun(
            () =>
              authClient.admin.banUser({
                userId,
                ...(reason.trim() !== "" ? { banReason: reason.trim() } : {}),
              }),
            "Could not ban user.",
          );
          setOpen(false);
        }}
        className="rounded-xs border border-magenta/50 bg-magenta/15 px-2 py-0.5 text-[11px] text-magenta hover:bg-magenta/25 disabled:opacity-50"
      >
        Confirm ban
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded-xs border border-line px-1.5 py-0.5 text-[11px] text-ink-faint hover:border-ink-muted"
      >
        Cancel
      </button>
    </span>
  );
}

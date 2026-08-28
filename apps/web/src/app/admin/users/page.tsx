import { user as userTable } from "@hoodmint/db";
import { desc } from "drizzle-orm";
import { container } from "@/lib/container.ts";
import { formatDateTimeUtc } from "@/lib/format.ts";
import { getSessionUser, requirePage } from "@/lib/session.ts";
import { CreateUserForm, UserRowActions } from "./user-management.tsx";

export const dynamic = "force-dynamic";

/** Admin → Users (PRD §7.5): roles, ban/disable, admin-only CRUD. */
export default async function AdminUsersPage() {
  // The admin surface is gated at audit:read (layout), but user CRUD is
  // admin-only both here (page guard) and server-side in the Better Auth
  // admin plugin (adminRole: "admin").
  await requirePage("users:manage");
  const current = await getSessionUser();
  const { db } = container();
  const users = await db
    .select()
    .from(userTable)
    .orderBy(desc(userTable.createdAt))
    .catch(() => []);

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <CreateUserForm />

      <section className="rounded-md border border-line bg-base-raised p-4 md:col-span-2">
        <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Users &amp; roles
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] text-ink-faint uppercase">
                <th scope="col" className="py-1 font-normal">
                  Name
                </th>
                <th scope="col" className="py-1 font-normal">
                  Email
                </th>
                <th scope="col" className="py-1 font-normal">
                  Role
                </th>
                <th scope="col" className="py-1 font-normal">
                  2FA
                </th>
                <th scope="col" className="py-1 font-normal">
                  Status
                </th>
                <th scope="col" className="py-1 font-normal">
                  Created
                </th>
                <th scope="col" className="py-1 font-normal">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="py-1">{u.name}</td>
                  <td className="py-1 text-ink-muted">{u.email}</td>
                  <td
                    className={
                      u.role === "admin"
                        ? "text-acid"
                        : u.role === "operator"
                          ? "text-cyan"
                          : "text-ink-muted"
                    }
                  >
                    {u.role}
                  </td>
                  <td className="py-1">{u.twoFactorEnabled ? "on" : "off"}</td>
                  <td className={u.banned ? "text-magenta" : "text-ink-muted"}>
                    {u.banned ? "banned" : "active"}
                  </td>
                  <td className="py-1 text-ink-faint">{formatDateTimeUtc(u.createdAt)}</td>
                  <td className="py-1">
                    <UserRowActions
                      userId={u.id}
                      email={u.email}
                      role={u.role ?? "viewer"}
                      banned={u.banned ?? false}
                      isSelf={current?.id === u.id}
                    />
                  </td>
                </tr>
              ))}
              {users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-2 text-ink-faint">
                    No users — bootstrap the first admin via /setup.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-ink-faint">
          Roles: admin (full), operator (scans/wallets/watchlists), viewer (read-only). All
          authorization is enforced server-side; users manage 2FA from their account settings. You
          cannot ban or remove your own account.
        </p>
      </section>
    </div>
  );
}

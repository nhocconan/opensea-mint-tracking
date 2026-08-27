import { user as userTable } from "@hoodmint/db";
import { desc } from "drizzle-orm";
import { container } from "@/lib/container.ts";
import { formatDateTimeUtc } from "@/lib/format.ts";

export const dynamic = "force-dynamic";

/** Admin → Users (PRD §7.5): roles, ban/disable, bootstrap-admin-only in v1. */
export default async function AdminUsersPage() {
  const { db } = container();
  const users = await db
    .select()
    .from(userTable)
    .orderBy(desc(userTable.createdAt))
    .catch(() => []);

  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        Users &amp; roles
      </h2>
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="text-[10px] text-ink-faint uppercase">
            <th className="py-1 font-normal">Name</th>
            <th className="py-1 font-normal">Email</th>
            <th className="py-1 font-normal">Role</th>
            <th className="py-1 font-normal">2FA</th>
            <th className="py-1 font-normal">Status</th>
            <th className="py-1 font-normal">Created</th>
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
            </tr>
          ))}
          {users.length === 0 ? (
            <tr>
              <td colSpan={6} className="py-2 text-ink-faint">
                No users — bootstrap the first admin via /setup.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <p className="mt-3 text-[11px] text-ink-faint">
        Roles: admin (full), operator (scans/wallets/watchlists), viewer (read-only). All
        authorization is enforced server-side; users manage 2FA from their account settings.
      </p>
    </section>
  );
}

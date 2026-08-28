/**
 * Single source of truth for admin sub-navigation — shared by
 * admin/layout.tsx (server) and the command palette (client) so the two
 * lists can't drift apart (2026-08-22).
 */
export const ADMIN_NAV = [
  ["/admin", "Overview"],
  ["/admin/guide", "Guide"],
  ["/admin/sources", "Sources"],
  ["/admin/opensea", "OpenSea"],
  ["/admin/signals", "Signals"],
  ["/admin/wallets", "Wallets"],
  ["/admin/alerts", "Alerts"],
  ["/admin/execution", "Execution"],
  ["/admin/special-mints", "Special mints"],
  ["/admin/users", "Users"],
  ["/admin/account", "Account"],
  ["/admin/audit", "Audit log"],
  ["/admin/system", "System"],
] as const;

export interface AdminNavSection {
  readonly href: string;
  readonly label: string;
  readonly shortLabel?: string;
  readonly category: "Data & Feeds" | "Operations" | "Management";
  readonly description: string;
  readonly icon:
    | "LayoutDashboard"
    | "RadioTower"
    | "Flame"
    | "Award"
    | "Radio"
    | "Wallet"
    | "Bell"
    | "Play"
    | "Sparkles"
    | "Users"
    | "UserCog"
    | "ScrollText"
    | "Sliders"
    | "BookOpen";
}

export const ADMIN_SECTIONS: readonly AdminNavSection[] = [
  {
    href: "/admin",
    label: "Overview",
    category: "Data & Feeds",
    description: "System health, discovery feeds, worker status, scan runs, and latency",
    icon: "LayoutDashboard",
  },
  {
    href: "/admin/sources",
    label: "Sources",
    category: "Data & Feeds",
    description: "External drop discovery providers, polling intervals, and feed ingestion",
    icon: "RadioTower",
  },
  {
    href: "/admin/opensea",
    label: "OpenSea",
    category: "Data & Feeds",
    description:
      "OpenSea API keys, wallet Personal Access Tokens (PAT), and allowlist verification",
    icon: "Flame",
  },
  {
    href: "/admin/nvt",
    label: "NeverFuckingTrade",
    shortLabel: "NVT Radar",
    category: "Data & Feeds",
    description: "NVT API key, OpenSea SIWE session pass, hourly scans, and Discord webhook alerts",
    icon: "Award",
  },
  {
    href: "/admin/signals",
    label: "Signals",
    category: "Data & Feeds",
    description: "xAI sentiment analysis credentials, model selection, and sentiment cache",
    icon: "Radio",
  },
  {
    href: "/admin/wallets",
    label: "Wallets",
    category: "Operations",
    description: "Tracked wallet addresses, custom labels, and encrypted execution keys",
    icon: "Wallet",
  },
  {
    href: "/admin/alerts",
    label: "Alerts",
    category: "Operations",
    description: "Notification channels (Discord, Telegram, Web Push), webhooks, and test alerts",
    icon: "Bell",
  },
  {
    href: "/admin/execution",
    label: "Execution",
    category: "Operations",
    description: "RPC endpoints, auto-mint policies, mint execution plans, and signers",
    icon: "Play",
  },
  {
    href: "/admin/special-mints",
    label: "Special mints",
    category: "Operations",
    description: "Custom mint targets, gas overrides, priority queues, and target configurations",
    icon: "Sparkles",
  },
  {
    href: "/admin/users",
    label: "Users",
    category: "Management",
    description: "Operator accounts, authentication roles, access policies, and invitations",
    icon: "Users",
  },
  {
    href: "/admin/account",
    label: "Account",
    category: "Management",
    description: "Personal operator session, email, password change, and security settings",
    icon: "UserCog",
  },
  {
    href: "/admin/audit",
    label: "Audit log",
    category: "Management",
    description:
      "Immutable record of administrative actions, credential changes, and system events",
    icon: "ScrollText",
  },
  {
    href: "/admin/system",
    label: "System",
    category: "Management",
    description:
      "System timezone (GMT+7), demo mode toggle, durable notification outbox, and manual scans",
    icon: "Sliders",
  },
  {
    href: "/admin/guide",
    label: "Guide",
    category: "Management",
    description: "Operator handbook, runbooks, credential setup instructions, and architecture",
    icon: "BookOpen",
  },
] as const;

/**
 * Single source of truth for admin sub-navigation — shared by
 * admin/layout.tsx (server) and the command palette (client) so the two
 * lists can't drift apart.
 */
export const ADMIN_NAV = ADMIN_SECTIONS.map((s) => [s.href, s.label] as const);

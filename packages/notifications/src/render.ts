/**
 * Alert message rendering — pure, secret-free by construction: inputs are
 * normalized domain data; the output feeds Telegram/webhook payloads.
 */
import type { AlertType } from "@hoodmint/core";
import { formatDateTimeGmt7 } from "@hoodmint/core";

export interface AlertRenderInput {
  readonly alertType: AlertType;
  readonly thresholdMinutes: number;
  readonly projectName: string;
  readonly projectSlug: string | null;
  readonly openseaUrl: string | null;
  readonly stageLabel: string;
  readonly stagePriceDisplay: string | null;
  readonly maxPerWallet: number | null;
  readonly walletLabel: string | null;
  readonly walletAddress: string;
  readonly startsAtIso: string | null;
  readonly endsAtIso: string | null;
}

export function formatCountdown(iso: string | null, nowIso: string): string | null {
  if (iso === null) {
    return null;
  }
  const deltaMs = Date.parse(iso) - Date.parse(nowIso);
  if (Number.isNaN(deltaMs)) {
    return null;
  }
  const abs = Math.abs(deltaMs);
  const minutes = Math.floor(abs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const suffix = deltaMs >= 0 ? "from now" : "ago";
  if (days > 0) {
    return `${days}d ${hours % 24}h ${suffix}`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${suffix}`;
  }
  return `${minutes}m ${suffix}`;
}

export function renderAlertMessage(input: AlertRenderInput, nowIso: string): string {
  const lines: string[] = [];
  const link =
    input.openseaUrl ??
    (input.projectSlug !== null
      ? `https://opensea.io/collection/${input.projectSlug}/overview`
      : null);
  const countdown = formatCountdown(input.startsAtIso, nowIso);

  switch (input.alertType) {
    case "restricted_eligible": {
      lines.push(`🎯 WL HIT: ${input.projectName}`);
      break;
    }
    case "stage_starting": {
      lines.push(
        `⏳ STARTING IN ${input.thresholdMinutes}m: ${input.projectName} — ${input.stageLabel}`,
      );
      break;
    }
    case "watched_live": {
      lines.push(`🔥 WATCHED DROP IS LIVE: ${input.projectName}`);
      break;
    }
    case "watched_nearing_sellout": {
      lines.push(`⚠️ NEARING SELL-OUT: ${input.projectName}`);
      break;
    }
    case "source_failure": {
      lines.push(`🛠 PROVIDER ISSUE: ${input.projectName}`);
      break;
    }
  }

  lines.push(
    `Stage: ${input.stageLabel} | Price: ${input.stagePriceDisplay ?? "?"} | Max/wallet: ${input.maxPerWallet ?? "?"}`,
  );
  if (input.walletAddress !== "") {
    lines.push(`Wallet: ${input.walletLabel ?? input.walletAddress}`);
  }
  if (countdown !== null) {
    lines.push(`Starts: ${formatDateTimeGmt7(input.startsAtIso)} (${countdown})`);
  }
  if (input.endsAtIso !== null) {
    lines.push(`Ends: ${formatDateTimeGmt7(input.endsAtIso)}`);
  }
  if (link !== null) {
    lines.push(`Mint: ${link}`);
  }
  return lines.join("\n");
}

export interface DiscordEmbedField {
  readonly name: string;
  readonly value: string;
  readonly inline?: boolean;
}

export interface DiscordEmbed {
  readonly title: string;
  readonly url?: string;
  readonly description?: string;
  /** Decimal RGB (Discord's embed color is an int, not a hex string). */
  readonly color: number;
  readonly fields: readonly DiscordEmbedField[];
  readonly footer: { readonly text: string };
  readonly timestamp: string;
}

// Discord embed limits, verified against docs.discord.com/developers/resources/message:
// title <=256, description <=4096, field.name <=256, field.value <=1024, fields <=25,
// footer.text <=2048, total combined embed characters across fields+title+desc+footer <=6000.
// Single content message <=2000 characters.
export function truncateDiscordString(value: string, max: number): string {
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Formats a date into Discord native relative timestamp (e.g. <t:1725760000:R> -> "in 2 hours"). */
export function formatDiscordRelativeTime(dateIso: string | number | Date): string {
  const ms = new Date(dateIso).getTime();
  if (Number.isNaN(ms)) return "";
  const sec = Math.floor(ms / 1000);
  return `<t:${sec}:R>`;
}

/** Formats a date into Discord native full timestamp (e.g. <t:1725760000:F>). */
export function formatDiscordFullTime(dateIso: string | number | Date): string {
  const ms = new Date(dateIso).getTime();
  if (Number.isNaN(ms)) return "";
  const sec = Math.floor(ms / 1000);
  return `<t:${sec}:F>`;
}

/** Chunks text into safe paragraphs/lines strictly under maxLen (default 1900 < 2000 limit). */
export function chunkDiscordMessage(content: string, maxLen = 1900): string[] {
  if (content.length <= maxLen) return [content];
  const lines = content.split("\n");
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      if (current.length > 0) {
        chunks.push(current.trim());
        current = "";
      }
      if (line.length > maxLen) {
        for (let i = 0; i < line.length; i += maxLen) {
          chunks.push(line.slice(i, i + maxLen));
        }
      } else {
        current = line;
      }
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

/** Enforces Discord's strict embed field limits and maximum 6000 total character budget. */
export function sanitizeDiscordEmbed(embed: DiscordEmbed): DiscordEmbed {
  const title = truncateDiscordString(embed.title, 256);
  const description = embed.description
    ? truncateDiscordString(embed.description, 4000)
    : undefined;
  const footerText = truncateDiscordString(embed.footer.text, 2048);

  const fields: DiscordEmbedField[] = (embed.fields ?? []).slice(0, 25).map((f) => ({
    name: truncateDiscordString(f.name, 256) || "—",
    value: truncateDiscordString(f.value, 1024) || "—",
    ...(f.inline !== undefined ? { inline: f.inline } : {}),
  }));

  let totalChars = title.length + (description?.length ?? 0) + footerText.length;
  const safeFields: DiscordEmbedField[] = [];

  for (const f of fields) {
    const fLen = f.name.length + f.value.length;
    if (totalChars + fLen > 5500) {
      break;
    }
    totalChars += fLen;
    safeFields.push(f);
  }

  return {
    title,
    ...(embed.url ? { url: embed.url } : {}),
    ...(description ? { description } : {}),
    color: embed.color,
    fields: safeFields,
    footer: { text: footerText },
    timestamp: embed.timestamp,
  };
}

const EMBED_TITLE_BY_TYPE: Record<AlertType, (input: AlertRenderInput) => string> = {
  restricted_eligible: (i) => `🎯 WL HIT: ${i.projectName}`,
  stage_starting: (i) =>
    `⏳ STARTING IN ${i.thresholdMinutes}m: ${i.projectName} — ${i.stageLabel}`,
  watched_live: (i) => `🔥 WATCHED DROP IS LIVE: ${i.projectName}`,
  watched_nearing_sellout: (i) => `⚠️ NEARING SELL-OUT: ${i.projectName}`,
  source_failure: (i) => `🛠 PROVIDER ISSUE: ${i.projectName}`,
};

const EMBED_COLOR_BY_TYPE: Record<AlertType, number> = {
  restricted_eligible: 0x39ff88,
  stage_starting: 0xffb300,
  watched_live: 0xff2ea6,
  watched_nearing_sellout: 0xffb300,
  source_failure: 0x8a8f98,
};

/** Same inputs as renderAlertMessage, structured and sanitized for a Discord embed. */
export function renderAlertEmbed(input: AlertRenderInput, nowIso: string): DiscordEmbed {
  const link =
    input.openseaUrl ??
    (input.projectSlug !== null
      ? `https://opensea.io/collection/${input.projectSlug}/overview`
      : null);
  const countdown = formatCountdown(input.startsAtIso, nowIso);

  const fields: DiscordEmbedField[] = [
    { name: "Stage", value: truncateDiscordString(input.stageLabel, 256), inline: true },
    {
      name: "Price",
      value: truncateDiscordString(input.stagePriceDisplay ?? "?", 256),
      inline: true,
    },
    {
      name: "Max/wallet",
      value: truncateDiscordString(String(input.maxPerWallet ?? "?"), 256),
      inline: true,
    },
  ];
  if (input.walletAddress !== "") {
    fields.push({
      name: "Wallet",
      value: truncateDiscordString(input.walletLabel ?? input.walletAddress, 256),
      inline: true,
    });
  }
  if (countdown !== null) {
    fields.push({
      name: "Starts",
      value: truncateDiscordString(`${formatDateTimeGmt7(input.startsAtIso)} (${countdown})`, 256),
      inline: false,
    });
  }
  if (input.endsAtIso !== null) {
    fields.push({
      name: "Ends",
      value: truncateDiscordString(formatDateTimeGmt7(input.endsAtIso), 256),
      inline: false,
    });
  }

  const rawEmbed: DiscordEmbed = {
    title: truncateDiscordString(EMBED_TITLE_BY_TYPE[input.alertType](input), 256),
    ...(link !== null ? { url: link } : {}),
    color: EMBED_COLOR_BY_TYPE[input.alertType],
    fields,
    footer: { text: "HoodMint Radar" },
    timestamp: nowIso,
  };

  return sanitizeDiscordEmbed(rawEmbed);
}

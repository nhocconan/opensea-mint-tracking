/**
 * Alert message rendering — pure, secret-free by construction: inputs are
 * normalized domain data; the output feeds Telegram/webhook payloads.
 */
import type { AlertType } from "@hoodmint/core";

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
    lines.push(`Starts: ${input.startsAtIso ?? "?"} (${countdown})`);
  }
  if (input.endsAtIso !== null) {
    lines.push(`Ends: ${input.endsAtIso}`);
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
  /** Decimal RGB (Discord's embed color is an int, not a hex string). */
  readonly color: number;
  readonly fields: readonly DiscordEmbedField[];
  readonly footer: { readonly text: string };
  readonly timestamp: string;
}

// Discord embed limits, verified against docs.discord.com/developers/resources/message
// 2026-08-22: title <=256, field.name <=256, field.value <=1024, combined
// title+description+field.name+field.value+footer.text+author.name across
// all embeds <=6000. We send one embed with a handful of short fields, well
// under the combined cap, but truncate defensively anyway.
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const EMBED_TITLE_BY_TYPE: Record<AlertType, (input: AlertRenderInput) => string> = {
  restricted_eligible: (i) => `🎯 WL HIT: ${i.projectName}`,
  stage_starting: (i) =>
    `⏳ STARTING IN ${i.thresholdMinutes}m: ${i.projectName} — ${i.stageLabel}`,
  watched_live: (i) => `🔥 WATCHED DROP IS LIVE: ${i.projectName}`,
  watched_nearing_sellout: (i) => `⚠️ NEARING SELL-OUT: ${i.projectName}`,
  source_failure: (i) => `🛠 PROVIDER ISSUE: ${i.projectName}`,
};

// Matches the DESIGN.md acid/cyan/magenta/amber role palette: acid for a
// positive eligible hit, amber for time-pressure, magenta for
// live/critical, cyan for informational, grey for an operational (not a
// mint) signal.
const EMBED_COLOR_BY_TYPE: Record<AlertType, number> = {
  restricted_eligible: 0x39ff88,
  stage_starting: 0xffb300,
  watched_live: 0xff2ea6,
  watched_nearing_sellout: 0xffb300,
  source_failure: 0x8a8f98,
};

/** Same inputs as renderAlertMessage, structured for a Discord embed. */
export function renderAlertEmbed(input: AlertRenderInput, nowIso: string): DiscordEmbed {
  const link =
    input.openseaUrl ??
    (input.projectSlug !== null
      ? `https://opensea.io/collection/${input.projectSlug}/overview`
      : null);
  const countdown = formatCountdown(input.startsAtIso, nowIso);

  const fields: DiscordEmbedField[] = [
    { name: "Stage", value: truncate(input.stageLabel, 256), inline: true },
    { name: "Price", value: truncate(input.stagePriceDisplay ?? "?", 256), inline: true },
    { name: "Max/wallet", value: truncate(String(input.maxPerWallet ?? "?"), 256), inline: true },
  ];
  if (input.walletAddress !== "") {
    fields.push({
      name: "Wallet",
      value: truncate(input.walletLabel ?? input.walletAddress, 256),
      inline: true,
    });
  }
  if (countdown !== null) {
    fields.push({
      name: "Starts",
      value: truncate(`${input.startsAtIso ?? "?"} (${countdown})`, 256),
      inline: false,
    });
  }
  if (input.endsAtIso !== null) {
    fields.push({ name: "Ends", value: truncate(input.endsAtIso, 256), inline: false });
  }

  return {
    title: truncate(EMBED_TITLE_BY_TYPE[input.alertType](input), 256),
    ...(link !== null ? { url: link } : {}),
    color: EMBED_COLOR_BY_TYPE[input.alertType],
    fields: fields.slice(0, 25),
    footer: { text: "HoodMint Radar" },
    timestamp: nowIso,
  };
}

/**
 * Scheduled NVT Discord scan worker pass.
 * Checks scan interval, sweeps upcoming drops in look-forward window (default 24h),
 * and alerts Discord on allowlist eligibility.
 */
import { findCredentialByType, getSetting } from "@hoodmint/db";
import { type NvtDiscordScanSettings, runNvtDiscordScanPass } from "@hoodmint/notifications";
import type { WorkerContext } from "../context.ts";

export async function runNvtScheduledScanPass(ctx: WorkerContext): Promise<void> {
  const { db, config, log } = ctx;

  const settings = await getSetting<NvtDiscordScanSettings>(db, "nvt_scan_settings");
  if (!settings?.enabled) {
    return;
  }

  const webhook = await findCredentialByType(db, "nvt_discord_webhook");
  if (!webhook) {
    return;
  }

  const periodMs = (settings.periodMinutes || 60) * 60 * 1000;
  if (settings.lastRunAt) {
    const elapsed = Date.now() - new Date(settings.lastRunAt).getTime();
    if (elapsed < periodMs) {
      return; // Not due yet
    }
  }

  log.info(
    { periodMinutes: settings.periodMinutes, lookForwardHours: settings.lookForwardHours },
    "running scheduled NVT Discord scan pass",
  );

  const result = await runNvtDiscordScanPass(db, config.APP_ENCRYPTION_KEY, {
    ...(config.NVT_API_KEY ? { nvtApiKey: config.NVT_API_KEY } : {}),
    ...(config.NVT_BASE_URL ? { nvtBaseUrl: config.NVT_BASE_URL } : {}),
  });

  if (result.ok) {
    log.info(
      {
        dropsFound: result.dropsFound,
        alertedCount: result.alertedCount,
      },
      "scheduled NVT Discord scan completed",
    );
  } else {
    log.warn({ message: result.message }, "scheduled NVT Discord scan completed with warnings");
  }
}

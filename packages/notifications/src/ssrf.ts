/**
 * SSRF protection for outbound webhooks (PRD §11):
 * - HTTPS only (loopback exempt only in explicit dev posture).
 * - Resolve DNS and reject loopback/link-local/private/unique-local ranges
 *   for IPv4 and IPv6 — the check happens on the resolved IPs, not the name.
 * - Redirects are never followed; timeouts and body limits are enforced by
 *   the caller-provided fetch wrapper.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "@hoodmint/core";

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  return (
    ((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)
  );
}

function isPrivateV4(ip: string): boolean {
  const value = ipv4ToInt(ip) >>> 0;
  const octet1 = value >>> 24;
  const octet2 = (value >>> 16) & 0xff;
  return (
    octet1 === 127 || // loopback
    octet1 === 10 || // private
    (octet1 === 172 && octet2 >= 16 && octet2 <= 31) || // private
    (octet1 === 192 && octet2 === 168) || // private
    (octet1 === 169 && octet2 === 254) || // link-local
    octet1 === 0 || // this-network
    octet1 >= 240 // reserved/multicast
  );
}

function isPrivateV6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fe80") || // link-local
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") || // unique local
    normalized.startsWith("ff") || // multicast
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("::ffff:172.")
  );
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return isPrivateV4(ip);
  }
  if (family === 6) {
    return isPrivateV6(ip);
  }
  return true;
}

export interface WebhookUrlOptions {
  /** Allow plain http on localhost for local development only. */
  readonly allowInsecureLoopback?: boolean;
  /** Injectable for tests. */
  readonly dnsLookup?: (host: string) => Promise<{ address: string }[]>;
}

export async function assertSafeWebhookUrl(
  rawUrl: string,
  options: WebhookUrlOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError("PermanentConfig", "webhook URL is not a valid URL");
  }

  const isLoopbackHost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";

  if (url.protocol !== "https:") {
    const allowHttp = options.allowInsecureLoopback === true && isLoopbackHost;
    if (!allowHttp) {
      throw new AppError("PermanentConfig", "webhook URL must use https");
    }
  }
  if (url.username !== "" || url.password !== "") {
    throw new AppError("PermanentConfig", "webhook URL must not embed credentials");
  }

  // Literal IPs checked directly; hostnames resolved and every address checked.
  const literal = isIP(url.hostname);
  if (literal !== 0) {
    if (
      isPrivateAddress(url.hostname) &&
      !(options.allowInsecureLoopback === true && isLoopbackHost && url.protocol === "http:")
    ) {
      throw new AppError("PermanentConfig", "webhook URL points at a private address");
    }
    return url;
  }

  const lookupFn = options.dnsLookup ?? ((host: string) => lookup(host, { all: true }));
  let addresses: { address: string }[];
  try {
    addresses = await lookupFn(url.hostname);
  } catch {
    throw new AppError("PermanentConfig", "webhook host does not resolve", {
      hint: "check the webhook hostname",
    });
  }
  for (const { address } of addresses) {
    if (
      isPrivateAddress(address) &&
      !(options.allowInsecureLoopback === true && isLoopbackHost && url.protocol === "http:")
    ) {
      throw new AppError("PermanentConfig", "webhook host resolves to a private address", {
        hint: "SSRF protection blocks internal destinations",
      });
    }
  }
  return url;
}

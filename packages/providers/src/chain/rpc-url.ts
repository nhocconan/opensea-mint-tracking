/**
 * Cloud-metadata SSRF guard for admin-configured RPC endpoints (ADR 0006).
 *
 * Unlike webhook URLs (packages/notifications/src/ssrf.ts), a private/LAN
 * address is a *legitimate* RPC target here — a self-hosted node is a
 * documented option (ADR 0006). So this does NOT block RFC1918/loopback
 * ranges. It blocks exactly one thing: the well-known cloud instance
 * metadata addresses, which no legitimate EVM RPC endpoint is ever hosted
 * on. If a compromised/phished admin session (or an operator who fat-
 * fingers a URL) points an RPC endpoint at a metadata service, the worker
 * process — which does make real outbound requests to every configured
 * endpoint — must not become an SSRF pivot into cloud credentials.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "@hoodmint/core";

const METADATA_HOSTNAMES = new Set([
  "169.254.169.254", // AWS / Azure / GCP / DigitalOcean IMDS
  "metadata.google.internal",
  "metadata.internal",
  "fd00:ec2::254", // AWS IMDSv2 IPv6
]);

export interface AssertSafeRpcUrlOptions {
  /** Injectable for tests. */
  readonly dnsLookup?: (host: string) => Promise<{ address: string }[]>;
}

/** Throws if the URL is malformed or resolves to a cloud metadata address. */
export async function assertSafeRpcUrl(
  rawUrl: string,
  options: AssertSafeRpcUrlOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError("PermanentConfig", "RPC URL is not a valid URL");
  }
  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:" &&
    url.protocol !== "ws:" &&
    url.protocol !== "wss:"
  ) {
    throw new AppError("PermanentConfig", "RPC URL must be http(s) or ws(s)");
  }

  const hostname = url.hostname.toLowerCase();
  if (METADATA_HOSTNAMES.has(hostname)) {
    throw new AppError("PermanentConfig", "RPC URL points at a cloud metadata endpoint");
  }

  // Literal IP: checked directly, no DNS round-trip needed.
  if (isIP(hostname) !== 0) {
    return url;
  }

  // Hostname: resolve and check every address a DNS-rebinding attacker
  // could later swap in — same discipline as the webhook guard.
  const lookupFn = options.dnsLookup ?? ((host: string) => lookup(host, { all: true }));
  try {
    const addresses = await lookupFn(hostname);
    for (const { address } of addresses) {
      if (METADATA_HOSTNAMES.has(address.toLowerCase())) {
        throw new AppError("PermanentConfig", "RPC host resolves to a cloud metadata endpoint");
      }
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    // DNS resolution failure here is a config problem, not a security
    // decision — let the caller's own connectivity check surface it.
  }
  return url;
}

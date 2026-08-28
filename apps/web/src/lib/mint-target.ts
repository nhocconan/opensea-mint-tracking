/**
 * Pure helpers for Admin → Special mints: resolving what the operator pasted
 * into a lookup key, and converting between the GMT+7 wall clock they type
 * and the UTC instant everything is stored in (PRD §14).
 *
 * Framework-free on purpose — the server action and the client form both
 * import this, and it is unit-testable without next/headers or the DB.
 */

/** Asia/Ho_Chi_Minh has been a fixed +07:00 with no DST since 1975, so the
 *  offset is a constant rather than a per-instant tz lookup. The round-trip
 *  test against `formatDateTimeGmt7` (which does go through Intl with
 *  timeZone "Asia/Ho_Chi_Minh") is what proves the two agree. */
export const GMT7_OFFSET_MINUTES = 7 * 60;
const GMT7_OFFSET_MS = GMT7_OFFSET_MINUTES * 60_000;

export type MintTarget =
  | { readonly kind: "slug"; readonly slug: string }
  | { readonly kind: "contract"; readonly address: string };

const CONTRACT_RE = /^0x[0-9a-fA-F]{40}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,80}$/;
/** …opensea.io[/<lang>]/collection/<segment>[/…] — the segment is a slug for
 *  curated drops and a bare contract address for many direct ones. */
const COLLECTION_URL_RE = /opensea\.io\/(?:[a-z]{2}\/)?collection\/([^/?#\s]+)/i;
/** Fallback for any other OpenSea URL shape (…/item/<chain>/<contract>/<id>,
 *  …/assets/…): the first 0x-address anywhere in the string. */
const ANY_CONTRACT_RE = /0x[0-9a-fA-F]{40}/;

/**
 * Classify one already-isolated token as a contract address or a collection
 * slug. Returns null when it is neither — never guesses.
 */
function classify(token: string): MintTarget | null {
  if (CONTRACT_RE.test(token)) {
    // Stored lowercased by the project upsert path; lowercase here so the
    // unique (chain_id, contract_address) index can actually be used.
    return { kind: "contract", address: token.toLowerCase() };
  }
  const slug = token.toLowerCase();
  // A `0x…` token that is not a well-formed 40-hex address is a mistyped
  // address, never a slug — the slug charset would otherwise happily accept
  // a truncated one and send a nonsense collection off to be fetched.
  if (slug.startsWith("0x")) {
    return null;
  }
  return SLUG_RE.test(slug) ? { kind: "slug", slug } : null;
}

/**
 * Accepts an OpenSea collection URL, a bare collection slug, or a raw
 * contract address. Fails closed (null) on anything else — a mint target is
 * never inferred from a partial match.
 */
export function parseMintTarget(raw: string): MintTarget | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const fromUrl = COLLECTION_URL_RE.exec(trimmed);
  if (fromUrl?.[1] !== undefined) {
    return classify(fromUrl[1]);
  }
  if (/opensea\.io\//i.test(trimmed)) {
    const address = ANY_CONTRACT_RE.exec(trimmed);
    return address === null ? null : { kind: "contract", address: address[0].toLowerCase() };
  }
  // Not a URL at all: a bare slug or a bare address.
  return /[/\s?#]/.test(trimmed) ? null : classify(trimmed);
}

const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Interpret a `<input type="datetime-local">` value (`YYYY-MM-DDTHH:mm`) as
 * a GMT+7 wall-clock time and return the UTC instant it denotes. Returns
 * null for anything malformed or for a date that does not exist (e.g.
 * 2026-02-30), which round-tripping the parsed components detects.
 *
 * Deliberately NOT `new Date(value)`: an un-suffixed datetime-local string
 * is parsed in the *server's* zone by the JS engine, which would silently
 * shift every mint time by whatever TZ the container happens to run in.
 */
export function gmt7LocalToUtc(value: string): Date | null {
  const m = LOCAL_DATETIME_RE.exec(value.trim());
  if (m === null) {
    return null;
  }
  const [year, month, day, hour, minute, second] = [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? "0"),
  ] as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const asUtcWallClock = Date.UTC(year, month - 1, day, hour, minute, second);
  const roundTrip = new Date(asUtcWallClock);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    return null;
  }
  return new Date(asUtcWallClock - GMT7_OFFSET_MS);
}

/**
 * Inverse of `gmt7LocalToUtc`: a UTC instant rendered as the
 * `YYYY-MM-DDTHH:mm` string a `<input type="datetime-local">` expects,
 * expressed in GMT+7. Used to prefill the manual override with the
 * auto-detected stage start.
 */
export function utcToGmt7LocalInput(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Date(date.getTime() + GMT7_OFFSET_MS).toISOString().slice(0, 16);
}

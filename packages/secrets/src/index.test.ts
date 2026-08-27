import { describe, expect, it } from "vitest";
import {
  fingerprint,
  maskTail,
  openSecret,
  redactDeep,
  redactUrl,
  safeEqual,
  sealSecret,
} from "./index.ts";

const KEY = Buffer.alloc(32, 3).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

describe("sealSecret / openSecret", () => {
  it("round-trips a PAT-length secret", () => {
    const sealed = sealSecret("opensea_pat_sk_abcdef0123456789", KEY);
    expect(sealed.algorithm).toBe("aes-256-gcm");
    expect(sealed.ciphertext).not.toContain("opensea");
    expect(openSecret(sealed, KEY)).toBe("opensea_pat_sk_abcdef0123456789");
  });

  it("uses a fresh nonce per call (identical inputs differ)", () => {
    const a = sealSecret("same", KEY);
    const b = sealSecret("same", KEY);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails closed on tampering", () => {
    const sealed = sealSecret("value", KEY);
    const bytes = Buffer.from(sealed.ciphertext, "base64");
    const last = bytes[bytes.length - 1];
    if (last !== undefined) {
      bytes[bytes.length - 1] = last ^ 0xff;
    }
    const tampered = { ...sealed, ciphertext: bytes.toString("base64") };
    expect(() => openSecret(tampered, KEY)).toThrow();
  });

  it("fails with the wrong key (rotation must be explicit)", () => {
    const sealed = sealSecret("value", KEY);
    expect(() => openSecret(sealed, OTHER_KEY)).toThrow();
  });

  it("rejects malformed master keys", () => {
    expect(() => sealSecret("v", "short")).toThrow(/32 bytes/);
  });
});

describe("display helpers", () => {
  it("fingerprint is stable and not reversible to input", () => {
    expect(fingerprint("sk-live-123")).toBe(fingerprint("sk-live-123"));
    expect(fingerprint("sk-live-123")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("maskTail shows only the last four characters", () => {
    expect(maskTail("abcdef123456")).toBe("••••3456");
    expect(maskTail("ab")).toBe("••••");
  });

  it("safeEqual is constant-time safe for unequal lengths", () => {
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "b")).toBe(false);
    expect(safeEqual("a", "aa")).toBe(false);
  });
});

describe("redaction", () => {
  it("redacts secret-bearing URL parameters", () => {
    expect(redactUrl("https://api.x.io/v1?key=hunter2&limit=10")).toBe(
      "https://api.x.io/v1?key=[REDACTED]&limit=10",
    );
    expect(redactUrl("https://api.telegram.org/bot123:secret/sendMessage")).not.toContain("secret");
  });

  it("redacts sensitive keys at any depth", () => {
    const input = {
      authorization: "Bearer jwt.value",
      nested: { "X-API-KEY": "sk-1", ok: "fine" },
      list: [{ token: "t" }],
    };
    const out = JSON.stringify(redactDeep(input));
    expect(out).not.toContain("jwt.value");
    expect(out).not.toContain("sk-1");
    expect(out).toContain("fine");
  });
});

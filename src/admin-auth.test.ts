import { expect, spyOn, test } from "bun:test";
import { authenticated } from "./admin-auth";
import { createHash, timingSafeEqual } from "node:crypto";

const secret = "0123456789abcdef".repeat(4);
const request = (key?: string) => new Request("https://service.example/admin/health", {
  headers: key === undefined ? {} : { "X-Castloop-Key": key },
});

for (const [label, key, expected] of [
  ["exact match", secret, true],
  ["missing header", undefined, false],
  ["empty header", "", false],
  ["shorter key", secret.slice(0, -1), false],
  ["longer key", `${secret}0`, false],
  ["same-length mismatch", `x${secret.slice(1)}`, false],
  ["case mismatch", secret.toUpperCase(), false],
  ["duplicate values", `${secret}, ${secret}`, false],
] as const) {
  test(`native admin key comparison handles ${label}`, async () => {
    expect(await authenticated(request(key), secret)).toBe(expected);
  });
}

test("an empty configured secret never authenticates", async () => {
  for (const key of [undefined, "", secret]) expect(await authenticated(request(key), "")).toBe(false);
});

test("the Workers extension receives two fixed-size SHA-256 digests", async () => {
  const original = Object.getOwnPropertyDescriptor(crypto.subtle, "timingSafeEqual");
  const calls: Array<[ArrayBuffer, ArrayBuffer]> = [];
  Object.defineProperty(crypto.subtle, "timingSafeEqual", { configurable: true, value: (a: ArrayBuffer, b: ArrayBuffer) => {
    calls.push([a, b]);
    expect(a.byteLength).toBe(32); expect(b.byteLength).toBe(32);
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } });
  try {
    expect(await authenticated(request(secret), secret)).toBe(true);
    expect(await authenticated(request("short"), secret)).toBe(false);
    expect(calls).toHaveLength(2);
    expect(Buffer.from(calls[1]![0])).toEqual(createHash("sha256").update("short").digest());
    expect(Buffer.from(calls[1]![1])).toEqual(createHash("sha256").update(secret).digest());
  } finally {
    if (original) Object.defineProperty(crypto.subtle, "timingSafeEqual", original);
    else Reflect.deleteProperty(crypto.subtle, "timingSafeEqual");
  }
});

test("standard Web Crypto falls back to native HMAC verification, not a JS byte comparison", async () => {
  const original = Object.getOwnPropertyDescriptor(crypto.subtle, "timingSafeEqual");
  Object.defineProperty(crypto.subtle, "timingSafeEqual", { configurable: true, value: undefined });
  const verify = spyOn(crypto.subtle, "verify");
  try {
    expect(await authenticated(request(secret), secret)).toBe(true);
    expect(await authenticated(request("wrong"), secret)).toBe(false);
    expect(verify).toHaveBeenCalledTimes(2);
    for (const [algorithm, key, signature, data] of verify.mock.calls) {
      expect(algorithm).toBe("HMAC"); expect(key.extractable).toBe(false);
      expect(key.algorithm.name).toBe("HMAC");
      expect(signature.byteLength).toBe(32); expect(data.byteLength).toBe(32);
    }
  } finally {
    verify.mockRestore();
    if (original) Object.defineProperty(crypto.subtle, "timingSafeEqual", original);
    else Reflect.deleteProperty(crypto.subtle, "timingSafeEqual");
  }
});

test("cryptographic failures reject authentication and log only an allowlisted diagnostic", async () => {
  const records: unknown[] = [];
  const logging = spyOn(console, "error").mockImplementation((value) => { records.push(value); });
  const digest = spyOn(crypto.subtle, "digest").mockRejectedValue(new Error(`private failure ${secret}`));
  try {
    expect(await authenticated(request(secret), secret)).toBe(false);
    expect(records).toEqual([JSON.stringify({ event: "admin_authentication_failed", reason_code: "crypto_unavailable" })]);
  } finally { digest.mockRestore(); logging.mockRestore(); }
});

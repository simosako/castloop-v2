import { expect, test } from "bun:test";
import { hmacSha256Hex, verifyHmacSha256Hex } from "./hmac";
import { createHmac } from "node:crypto";

test("HMAC-SHA256 matches independent UTF-8 signatures and rejects altered or malformed inputs", async () => {
  const message = "castloop/test\n番組🎙", secret = "管理者-key";
  const mac = createHmac("sha256", secret).update(message).digest("hex");
  expect(await hmacSha256Hex(message, secret)).toBe(mac);
  expect(await verifyHmacSha256Hex(message, mac, secret)).toBe(true);
  expect(await verifyHmacSha256Hex(`${message}\n`, mac, secret)).toBe(false);
  expect(await verifyHmacSha256Hex(message, mac, "another-key")).toBe(false);
  for (const value of ["", "aa", "g".repeat(64), mac.toUpperCase(), `${mac}\n`]) {
    expect(await verifyHmacSha256Hex(message, value, secret)).toBe(false);
  }
});

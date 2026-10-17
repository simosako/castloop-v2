import { expect, test } from "bun:test";
import { sha256Hex, toHex, utf8Bytes } from "./sha256";
import { createHash } from "node:crypto";

test("SHA-256 preserves known vectors, UTF-8 encoding and exact byte views", async () => {
  expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const source = "番組🎙\u0000\ufeff";
  expect(await sha256Hex(source)).toBe(createHash("sha256").update(source).digest("hex"));
  expect([...utf8Bytes(source)]).toEqual([...new TextEncoder().encode(source)]);
  const bytes = Uint8Array.from([0, 97, 98, 99, 255]);
  expect(await sha256Hex(bytes.subarray(1, 4))).toBe(await sha256Hex("abc"));
  expect(await sha256Hex(bytes.buffer)).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(toHex(bytes.buffer)).toBe("00616263ff");
});

import { toHex, utf8Bytes } from "./sha256";

async function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey("raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await hmacKey(secret, "sign");
  return toHex(await crypto.subtle.sign("HMAC", key, utf8Bytes(message)));
}

export async function verifyHmacSha256Hex(message: string, mac: string, secret: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(mac)) return false;
  const key = await hmacKey(secret, "verify");
  const signature = Uint8Array.from(mac.match(/../g)!, (part) => Number.parseInt(part, 16));
  return crypto.subtle.verify("HMAC", key, signature, utf8Bytes(message));
}

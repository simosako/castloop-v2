export function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function utf8Bytes(source: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(source));
}

export async function sha256Hex(input: string | Uint8Array | ArrayBuffer): Promise<string> {
  const data = typeof input === "string" ? utf8Bytes(input)
    : input instanceof Uint8Array ? input : new Uint8Array(input);
  return toHex(await crypto.subtle.digest("SHA-256", data));
}

export function decodeUtf8Strict(buffer: Buffer | Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
}

export function decodeUtf8PreservingBom(buffer: Buffer | Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buffer);
}

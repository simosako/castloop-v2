import { sha256HexSync } from "./sha256";

export function workerPayloadHash(input: string | object): string {
  return sha256HexSync(typeof input === "string" ? input : JSON.stringify(input));
}

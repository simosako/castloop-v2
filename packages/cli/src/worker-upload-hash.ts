import { createHash } from "node:crypto";

export function workerPayloadHash(input: string | object): string {
  return createHash("sha256").update(typeof input === "string" ? input : JSON.stringify(input)).digest("hex");
}

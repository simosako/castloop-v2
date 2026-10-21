import type { SqlitePublicationBucket } from "../sqlite-publication-executor";
import { createHash } from "node:crypto";

type Entry = { key: string; bytes: Uint8Array; size: number; etag: string; version: string;
  httpEtag: string; uploaded: Date;
  checksums: { sha256?: ArrayBuffer }; customMetadata?: Record<string, string>; httpMetadata?: R2HTTPMetadata };

export function sqlitePublicationBucket() {
  const entries = new Map<string, Entry>(), calls: Array<{ method: string; key: string }> = [];
  const hooks: { beforePut?: (key: string) => Promise<void>; afterPut?: (key: string) => Promise<void>;
    beforeGet?: (key: string) => Promise<void>; beforeHead?: (key: string) => Promise<void> } = {};
  const bucket: SqlitePublicationBucket & { delete: (key: string) => Promise<void> } = {
    async delete(key) { calls.push({ method: "DELETE", key }); entries.delete(key); },
    async head(key) { calls.push({ method: "HEAD", key }); await hooks.beforeHead?.(key); return entries.get(key) ?? null; },
    async get(key, options) {
      calls.push({ method: "GET", key });
      await hooks.beforeGet?.(key);
      const object = entries.get(key);
      if (!object) return null;
      if (options?.onlyIf && !(options.onlyIf instanceof Headers) && options.onlyIf.etagMatches !== object.etag) return object;
      return { ...object, body: new Blob([object.bytes]).stream() };
    },
    async put(key, body, options) {
      calls.push({ method: "PUT", key });
      await hooks.beforePut?.(key);
      const existing = entries.get(key);
      if (options?.onlyIf instanceof Headers && options.onlyIf.get("If-None-Match") === "*" && existing) return null;
      if (options?.onlyIf && !(options.onlyIf instanceof Headers) && options.onlyIf.etagMatches && options.onlyIf.etagMatches !== existing?.etag) return null;
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body.slice() : new Uint8Array(await new Response(body).arrayBuffer());
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (options?.sha256 !== undefined && options.sha256 !== digest) throw new Error("Binding rejected checksum mismatch");
      const object: Entry = { key, bytes, size: bytes.length, etag: crypto.randomUUID(), version: crypto.randomUUID(),
        httpEtag: `"${digest}"`, uploaded: new Date(),
        checksums: options?.sha256 ? { sha256: Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer } : {},
        ...(options?.customMetadata ? { customMetadata: options.customMetadata } : {}),
        ...(options?.httpMetadata && !(options.httpMetadata instanceof Headers) ? { httpMetadata: options.httpMetadata } : {}) };
      entries.set(key, object);
      await hooks.afterPut?.(key);
      return object;
    },
    async list(options) {
      calls.push({ method: "LIST", key: options.prefix });
      const objects = [...entries.values()].filter((entry) => entry.key.startsWith(options.prefix)).sort((a, b) => a.key.localeCompare(b.key));
      return { objects: objects.slice(0, options.limit), truncated: objects.length > options.limit };
    },
  };
  return { bucket, entries, calls, hooks, text: (key: string) => new TextDecoder().decode(entries.get(key)?.bytes) };
}

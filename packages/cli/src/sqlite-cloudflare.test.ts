import { expect, test } from "bun:test";
import { SqliteCloudflareApi } from "./sqlite-cloudflare";

test("Cloudflare mutation response overflow awaits cleanup and never retries", async () => {
  for (const cleanupFails of [false, true]) {
    const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    let calls = 0, finished = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1_000_001)); },
      async cancel() { entered.resolve(); await release.promise; if (cleanupFails) throw new Error("private cleanup"); } });
    const api = new SqliteCloudflareApi({ schema_version: 2, storage_layout: "show-v1", publication_protocol: "sqlite-sequential-v1",
      service_id: "service", account_id: "a".repeat(32), bucket_name: "private-bucket", worker_name: "worker",
      public_base_url: "https://worker.example.workers.dev", workers_dev_base_url: "https://worker.example.workers.dev" },
    { accountId: "a".repeat(32), apiToken: "private", transport: async () => { calls++; return new Response(body); } });
    const result = api.createBucket().then(() => "unexpected success", (error: Error) => error.message).finally(() => { finished = true; });
    await entered.promise;
    try { expect(finished).toBe(false); expect(calls).toBe(1); } finally { release.resolve(); }
    expect(await result).toBe("Cloudflare response was not verified; do not replay a mutation");
    expect(calls).toBe(1); expect(body.locked).toBe(false);
  }
});

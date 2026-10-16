import { expect, spyOn, test } from "bun:test";
import { putVerifiedR2Object } from "./verified-r2-put";
import { createHash } from "node:crypto";

for (const phase of ["put", "put_receipt", "source_completed", "readback", "readback_verify"] as const) {
  test(`R2 PUT failures identify ${phase} without logging keys, credentials, body or arbitrary exceptions`, async () => {
    const bytes = Uint8Array.of(1), records: string[] = [];
    const logging = spyOn(console, "error").mockImplementation((message) => { records.push(String(message)); });
    try {
      await expect(putVerifiedR2Object({ account_id: "private-account", bucket_name: "private-bucket" }, {
        key: "private-key", length: 1, sha256: createHash("sha256").update(bytes).digest("hex"), contentType: "application/octet-stream" },
      new Blob([bytes]).stream(), () => { if (phase === "source_completed") throw new Error("private exception"); }, {
        accountId: "private-account", apiToken: "private-token", transport: async (_, init) => {
          if (init?.method === "GET") {
            if (phase === "readback") throw new Error("private exception");
            return new Response(bytes, { headers: { ETag: '"changed"' } });
          }
          if (phase === "put") return new Response(null, { status: 503 });
          return Response.json({ success: true, result: { key: "private-key", size: phase === "put_receipt" ? 2 : 1, etag: "verified", version: "version" } });
        },
      })).rejects.toThrow("no automatic retry");
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0])).toEqual({ event: "r2_verified_put_failed", phase, reason_code: "put_or_readback_unverified",
        ...(phase === "readback" ? {} : { http_status: phase === "put" ? 503 : 200 }) });
      expect(records[0]).not.toContain("private");
    } finally { logging.mockRestore(); }
  });
}

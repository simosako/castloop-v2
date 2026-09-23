import { describe, expect, test } from "bun:test";
import worker from "./index";

type RecordValue = { show_id: string; reservation_id: string };

function bucket() {
  const entries = new Map<string, string>();
  return {
    entries,
    put: async (key: string, value: string, options: { onlyIf: Headers }) => {
      if (options.onlyIf.get("If-None-Match") === "*" && entries.has(key)) return null;
      entries.set(key, value);
      return { key };
    },
    get: async (key: string) => entries.has(key) ? { json: async () => JSON.parse(entries.get(key)!) as RecordValue } : null,
  };
}

describe("Show ID reservation", () => {
  test("concurrent requests have one owner; only its retry succeeds", async () => {
    const storage = bucket();
    const env = { CASTLOOP_BUCKET: storage, CASTLOOP_ADMIN_KEY: "test-secret" };
    const claim = (id: string, secret = "test-secret") => worker.fetch(new Request(
      "https://example.workers.dev/admin/shows/reserve", {
        method: "POST", headers: { "X-Castloop-Key": secret },
        body: JSON.stringify({ show_id: "daily", reservation_id: id }),
      }), env as never);
    const ids = Array.from({ length: 12 }, () => crypto.randomUUID());
    const results = await Promise.all(ids.map((id) => claim(id)));
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.status === 409)).toHaveLength(11);
    const owner = JSON.parse(storage.entries.get("system/show-reservations/daily.json")!) as RecordValue;
    expect((await claim(owner.reservation_id)).status).toBe(200);
    expect((await claim(crypto.randomUUID())).status).toBe(409);
    expect((await claim(owner.reservation_id, "wrong-secret")).status).toBe(401);
  });
});

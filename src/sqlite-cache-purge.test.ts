import { expect, test } from "bun:test";
import { purgeSqliteCache } from "./sqlite-cache-purge";
import type { SqliteCachePurgeEvent } from "./sqlite-cache-purge";

test("SQLite combines tag and slash-bounded prefix invalidation in one acknowledged purge", async () => {
  const calls: CachePurgeOptions[] = [];
  const cache = { async purge(target: CachePurgeOptions) { calls.push(target); return { success: true, errors: [] }; } };
  await purgeSqliteCache(cache, { showId: "a-b", episodeId: "c" });
  await purgeSqliteCache(cache, { showId: "a" });
  expect(calls).toEqual([
    { tags: ["feed-a-b", "episode-a-b/c"], pathPrefixes: ["/podcasts/a-b/episodes/c/"] },
    { tags: ["show-a", "feed-a", "cover-a"], pathPrefixes: ["/podcasts/a/"] },
  ]);
});

test("acknowledged rejection waits before retrying the exact purge, not publication", async () => {
  const calls: CachePurgeOptions[] = [], waits: number[] = [], events: SqliteCachePurgeEvent[] = [];
  await purgeSqliteCache({ async purge(target) { calls.push(target); return { success: calls.length === 3,
    errors: [{ code: 999, message: "Too many requests: Private title private@example.com secret" }] }; } }, { showId: "daily" }, {
    delay: async (milliseconds) => { waits.push(milliseconds); expect(calls.length).toBe(waits.length); },
    onEvent: (event) => events.push(event),
  });
  expect(calls).toHaveLength(3);
  expect(calls.every((call) => call === calls[0])).toBe(true);
  expect(waits).toEqual([12000, 12000]);
  expect(events.map((event) => [event.reason_code, event.attempt, event.will_retry])).toEqual([
    ["purge_rate_limited", 1, true], ["purge_rate_limited", 2, true],
  ]);
  expect(JSON.stringify(events)).not.toMatch(/Private|private@|secret|999/);
});

test("negative acknowledgements have finite attempts and never report completion", async () => {
  let calls = 0;
  const waits: number[] = [], events: SqliteCachePurgeEvent[] = [];
  await expect(purgeSqliteCache({ async purge() { calls++; return { success: false, errors: [{ code: 999, message: "Rate limit exceeded" }] }; } }, { showId: "daily" }, {
    delay: async (milliseconds) => { waits.push(milliseconds); }, onEvent: (event) => events.push(event),
  })).rejects.toThrow("bounded waiting");
  expect(calls).toBe(6);
  expect(waits).toEqual(Array(5).fill(12000));
  expect(events.at(-1)).toMatchObject({ reason_code: "purge_rate_limited", attempt: 6, will_retry: false });
});

test("unclassified or permanent rejection is not retried", async () => {
  for (const errors of [[], [{ code: 999, message: "Private invalid input secret" }],
    [{ code: 998, message: "Rate limit exceeded" }, { code: 999, message: "Private invalid input secret" }]]) {
    let calls = 0, waits = 0;
    const events: SqliteCachePurgeEvent[] = [];
    await expect(purgeSqliteCache({ async purge() { calls++; return { success: false, errors }; } },
      { showId: "daily" }, { delay: async () => { waits++; }, onEvent: (event) => events.push(event) })).rejects.toThrow("rejected");
    expect(calls).toBe(1);
    expect(waits).toBe(0);
    expect(events).toEqual([{ event: "sqlite_cache_purge", show_id: "daily", reason_code: "purge_rejected", attempt: 1, will_retry: false }]);
  }
});

test("a thrown or malformed purge result is unknown and is never resent", async () => {
  for (const malformed of [false, true]) {
    let calls = 0, waits = 0;
    const events: SqliteCachePurgeEvent[] = [];
    await expect(purgeSqliteCache({ async purge() {
      calls++;
      if (malformed) return undefined as never;
      throw new Error("Private title private@example.com secret");
    } }, { showId: "daily" }, { delay: async () => { waits++; }, onEvent: (event) => events.push(event) })).rejects.toThrow("unconfirmed");
    expect(calls).toBe(1);
    expect(waits).toBe(0);
    expect(events).toEqual([{ event: "sqlite_cache_purge", show_id: "daily", reason_code: "purge_unconfirmed", attempt: 1, will_retry: false,
      ...(malformed ? { failure_kind: "invalid_acknowledgement", result_kind: "undefined", success_kind: "undefined" } :
        { failure_kind: "call_threw", exception_kind: "other" }) }]);
    expect(JSON.stringify(events)).not.toMatch(/Private|private@|secret/);
  }
});

test("malformed acknowledgement diagnostics retain only value types, never response contents", async () => {
  for (const [result, resultKind, successKind] of [[null, "null", "undefined"], [42, "number", "undefined"],
    [{ success: "private@example.com secret", errors: ["Private title"] }, "object", "string"],
    [{ success: null }, "object", "null"], [{}, "object", "undefined"]] as const) {
    let calls = 0;
    const events: SqliteCachePurgeEvent[] = [];
    await expect(purgeSqliteCache({ async purge() { calls++; return result as never; } }, { showId: "daily" }, {
      delay: async () => { throw new Error("Malformed acknowledgements must not be retried"); }, onEvent: (event) => events.push(event),
    })).rejects.toThrow("unconfirmed");
    expect(calls).toBe(1);
    expect(events).toEqual([{ event: "sqlite_cache_purge", show_id: "daily", reason_code: "purge_unconfirmed", attempt: 1,
      will_retry: false, failure_kind: "invalid_acknowledgement", result_kind: resultKind, success_kind: successKind }]);
    expect(JSON.stringify(events)).not.toMatch(/Private|private@|secret/);
  }
});

test("purge exceptions expose only allowlisted categories without enabling retries", async () => {
  for (const [error, kind] of [[new TypeError("Private secret"), "type_error"],
    [new Error("Internal error; private@example.com secret"), "internal_error"],
    [new Error("Private internal error secret"), "other"], ["Internal error; secret", "other"]] as const) {
    let calls = 0;
    const events: SqliteCachePurgeEvent[] = [];
    await expect(purgeSqliteCache({ async purge() { calls++; throw error; } }, { showId: "daily" }, {
      delay: async () => { throw new Error("Unknown purges must not be retried"); }, onEvent: (event) => events.push(event),
    })).rejects.toThrow("unconfirmed");
    expect(calls).toBe(1);
    expect(events[0]).toMatchObject({ failure_kind: "call_threw", exception_kind: kind, will_retry: false });
    expect(JSON.stringify(events)).not.toMatch(/Private|private@|secret/);
  }
});

test("unavailable cache and invalid targets never send a purge", async () => {
  let calls = 0;
  const cache = { async purge() { calls++; return { success: true, errors: [] }; } };
  await expect(purgeSqliteCache(undefined, { showId: "daily" })).rejects.toThrow("unavailable");
  await expect(purgeSqliteCache(cache, { showId: "../daily" })).rejects.toThrow();
  await expect(purgeSqliteCache(cache, { showId: "daily", episodeId: "../first" })).rejects.toThrow();
  expect(calls).toBe(0);
});

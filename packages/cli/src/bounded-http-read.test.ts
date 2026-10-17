import { expect, spyOn, test } from "bun:test";
import { collectStreamBytes, retryAfterMilliseconds } from "./bounded-http-read";

test("bounded stream collection preserves chunks and releases its reader at the exact byte limit", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(Uint8Array.from([9, 1, 2]).subarray(1));
    controller.enqueue(Uint8Array.from([3])); controller.close();
  } });
  expect(await collectStreamBytes(body, 3)).toEqual(Uint8Array.from([1, 2, 3]));
  expect(body.locked).toBe(false);
  expect(await collectStreamBytes(new ReadableStream({ start(c) { c.close(); } }), 1)).toEqual(new Uint8Array());
});

test("overflow waits for cancellation and releases the lock even when cancellation fails", async () => {
  for (const cleanupFails of [false, true]) {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4)); }, async cancel() {
      await Bun.sleep(1); canceled = true;
      if (cleanupFails) throw new Error("private cleanup error");
    } });
    await expect(collectStreamBytes(body, 3)).rejects.toMatchObject({ code: cleanupFails ? "cleanup_failed" : "size_limit" });
    expect(canceled).toBe(true); expect(body.locked).toBe(false);
  }
});

test("terminal read failures retain each caller's cancellation policy", async () => {
  for (const cancelOnTerminal of [false, true]) {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("private read error")); } });
    await expect(collectStreamBytes(body, 3, cancelOnTerminal)).rejects.toMatchObject({
      code: cancelOnTerminal ? "cleanup_failed" : "body_read_failed",
    });
    expect(body.locked).toBe(false);
  }
});

test("Retry-After parsing preserves seconds, HTTP dates, absent/invalid headers and overflow", () => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-17T00:00:00Z"));
  try {
    for (const [value, expected] of [["1.2345", 1235], ["Sat, 17 Oct 2026 00:00:02 GMT", 2000],
      ["Fri, 16 Oct 2026 00:00:00 GMT", 0], ["invalid", undefined], ["9".repeat(400), Infinity]] as const) {
      expect(retryAfterMilliseconds(new Response(null, { headers: { "Retry-After": value } }))).toBe(expected);
    }
    expect(retryAfterMilliseconds(new Response(null))).toBeUndefined();
  } finally { clock.mockRestore(); }
});

import { describe, expect, test } from "bun:test";
import { readBoundedAdminJson } from "./admin-body";

describe("bounded administrator JSON bodies", () => {
  test("reads UTF-8 split across chunks and accepts exactly the declared budget", async () => {
    const bytes = new TextEncoder().encode('{"text":"日本語"}');
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } });
    const request = new Request("https://admin.invalid/", { method: "POST", headers: { "Content-Length": String(bytes.length) }, body });
    expect(await readBoundedAdminJson(request, bytes.length)).toEqual({ text: "日本語" });
    expect(request.body?.locked).toBe(false);
  });

  test("excess body cancellation is awaited before rejecting and releasing its reader", async () => {
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const request = new Request("https://admin.invalid/", { method: "POST", body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(11)); },
      async cancel() { started.resolve(); await ended.promise; },
    }) });
    const pending = readBoundedAdminJson(request, 10);
    let finished = false;
    const observed = pending.catch(() => { finished = true; });
    await started.promise;
    expect(finished).toBe(false);
    expect(request.body?.locked).toBe(true);
    ended.resolve();
    await expect(pending).rejects.toThrow("budget");
    await observed;
    expect(request.body?.locked).toBe(false);
  });

  test("rejects invalid or oversized length declarations before consuming any body", async () => {
    for (const declared of ["-1", "no", "1.5", "9007199254740992", "11"]) {
      const request = new Request("https://admin.invalid/", { method: "POST", headers: { "Content-Length": declared }, body: "{}" });
      await expect(readBoundedAdminJson(request, 10)).rejects.toThrow("length");
      expect(request.bodyUsed).toBe(false);
    }
  });

  test("missing/invalid JSON, malformed UTF-8, dishonest lengths and invalid budgets fail closed", async () => {
    const requests = [
      new Request("https://admin.invalid/", { method: "POST" }),
      new Request("https://admin.invalid/", { method: "POST", body: "{" }),
      new Request("https://admin.invalid/", { method: "POST", body: Uint8Array.of(0xff) }),
      new Request("https://admin.invalid/", { method: "POST", headers: { "Content-Length": "3" }, body: "{}" }),
    ];
    for (const request of requests) await expect(readBoundedAdminJson(request)).rejects.toThrow();
    for (const maximum of [0, -1, 1.5, Infinity]) {
      await expect(readBoundedAdminJson(new Request("https://admin.invalid/", { method: "POST", body: "{}" }), maximum)).rejects.toThrow("budget");
    }
  });
});

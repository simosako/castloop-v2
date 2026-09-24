import { expect, test } from "bun:test";
import { waitForWorkerHealth } from "./health";

test("init waits for a newly deployed Worker URL to resolve", async () => {
  let calls = 0;
  const delays: number[] = [];
  await waitForWorkerHealth("https://castloop.example", "test-key", async (url, options) => {
    expect(url.pathname).toBe("/admin/health");
    expect(new Headers(options.headers).get("X-Castloop-Key")).toBe("test-key");
    calls += 1;
    return new Response(null, { status: calls < 3 ? 404 : 200 });
  }, async (ms) => { delays.push(ms); });
  expect(calls).toBe(3);
  expect(delays).toEqual([2000, 2000]);
});

test("init retries temporary network and server failures", async () => {
  let calls = 0;
  await waitForWorkerHealth("https://castloop.example", "test-key", async () => {
    calls += 1;
    if (calls === 1) throw new Error("Network is unavailable");
    return new Response(null, { status: calls === 2 ? 503 : 200 });
  }, async () => {});
  expect(calls).toBe(3);
});

test("init does not retry a bad administrator key", async () => {
  let calls = 0;
  await expect(waitForWorkerHealth("https://castloop.example", "test-key", async () => {
    calls += 1;
    return new Response(null, { status: 401 });
  }, async () => {})).rejects.toThrow("HTTP 401");
  expect(calls).toBe(1);
});

test("init stops waiting if the Worker URL stays unavailable", async () => {
  let calls = 0;
  let delays = 0;
  await expect(waitForWorkerHealth("https://castloop.example", "test-key", async () => {
    calls += 1;
    return new Response(null, { status: 404 });
  }, async () => { delays += 1; })).rejects.toThrow("after 6 attempts (HTTP 404)");
  expect(calls).toBe(6);
  expect(delays).toBe(5);
});

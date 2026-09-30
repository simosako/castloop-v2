import { expect, test } from "bun:test";
import { waitForWorkerHealth } from "./health";

function clock() {
  let elapsed = 0;
  const delays: number[] = [];
  const messages: string[] = [];
  return {
    delays,
    messages,
    advance: (milliseconds: number) => { elapsed += milliseconds; },
    wait: async (milliseconds: number) => {
      delays.push(milliseconds);
      elapsed += milliseconds;
    },
    options: { now: () => elapsed, report: (message: string) => { messages.push(message); } },
  };
}

test("init waits for a newly deployed Worker URL to resolve", async () => {
  let calls = 0;
  const time = clock();
  await waitForWorkerHealth("https://castloop.example", "test-key", async (url, options) => {
    expect(url.pathname).toBe("/admin/health");
    expect(new Headers(options.headers).get("X-Castloop-Key")).toBe("test-key");
    expect(options.redirect).toBe("manual");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    calls += 1;
    return new Response(null, { status: calls < 3 ? 404 : 200 });
  }, time.wait, time.options);
  expect(calls).toBe(3);
  expect(time.delays).toEqual([5000, 5000]);
  expect(time.messages).toHaveLength(2);
  expect(time.messages[0]).toContain("HTTP 404");
  expect(time.messages[0]).toContain("120s remaining");
  expect(time.messages.join("\n")).not.toContain("test-key");
});

test("init retries temporary network and server failures", async () => {
  let calls = 0;
  const time = clock();
  await waitForWorkerHealth("https://castloop.example", "test-key", async () => {
    calls += 1;
    if (calls === 1) throw new Error("Network is unavailable");
    return new Response(null, { status: calls === 2 ? 503 : 200 });
  }, time.wait, time.options);
  expect(calls).toBe(3);
  expect(time.messages[0]).toContain("network request failed");
  expect(time.messages[1]).toContain("HTTP 503");
});

test("init does not retry bad credentials, redirects or permanent client errors", async () => {
  for (const status of [400, 401, 403, 302]) {
    let calls = 0;
    const time = clock();
    await expect(waitForWorkerHealth("https://castloop.example", "test-key", async () => {
      calls += 1;
      return new Response(null, { status });
    }, time.wait, time.options)).rejects.toThrow(`HTTP ${status}`);
    expect(calls).toBe(1);
    expect(time.delays).toEqual([]);
    expect(time.messages).toEqual([]);
  }
});

test("init stops waiting if the Worker URL stays unavailable", async () => {
  let calls = 0;
  const time = clock();
  await expect(waitForWorkerHealth("https://castloop.example", "test-key", async () => {
    calls += 1;
    return new Response(null, { status: 404 });
  }, time.wait, time.options)).rejects.toThrow("after 120s and 24 attempts (HTTP 404)");
  expect(calls).toBe(24);
  expect(time.delays).toHaveLength(24);
  expect(time.options.now()).toBe(120000);
});

test("init survives more than six initial 404 responses without restarting", async () => {
  let calls = 0;
  const time = clock();
  await waitForWorkerHealth("https://castloop.example", "test-key", async () => {
    calls += 1;
    return new Response(null, { status: calls <= 6 ? 404 : 200 });
  }, time.wait, time.options);
  expect(calls).toBe(7);
  expect(time.options.now()).toBe(30000);
});

test("init also retries rate limiting within the same deadline", async () => {
  let calls = 0;
  const time = clock();
  await waitForWorkerHealth("https://castloop.example", "test-key", async () => {
    calls += 1;
    return new Response(null, { status: calls === 1 ? 429 : 200 });
  }, time.wait, time.options);
  expect(calls).toBe(2);
  expect(time.messages[0]).toContain("HTTP 429");
});

test("request time counts toward the deadline and the last delay is shortened", async () => {
  let calls = 0;
  const time = clock();
  await expect(waitForWorkerHealth("https://castloop.example", "test-key", async () => {
    calls += 1;
    time.advance(4500);
    return new Response(null, { status: 503 });
  }, time.wait, time.options)).rejects.toThrow("after 120s and 13 attempts (HTTP 503)");
  expect(calls).toBe(13);
  expect(time.delays.at(-1)).toBe(1500);
  expect(time.options.now()).toBe(120000);
});

test("a successful first health request produces no waiting output", async () => {
  const time = clock();
  await waitForWorkerHealth("https://castloop.example", "test-key",
    async () => new Response(null, { status: 200 }), time.wait, time.options);
  expect(time.delays).toEqual([]);
  expect(time.messages).toEqual([]);
});

test("the final request timeout is limited to the remaining deadline", async () => {
  let elapsed = 0;
  let calls = 0;
  const delays: number[] = [];
  await expect(waitForWorkerHealth("https://castloop.example", "test-key", async (_url, options) => {
    calls += 1;
    const signal = options.signal;
    if (!signal) throw new Error("Missing request timeout");
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        elapsed = 120000;
        reject(signal.reason);
      }, { once: true });
    });
    throw new Error("Request should have timed out");
  }, async (ms) => { delays.push(ms); }, {
    now: () => {
      const current = elapsed;
      if (elapsed === 0) elapsed = 119990;
      return current;
    },
    report: () => {},
  })).rejects.toThrow("after 120s and 1 attempt (network request failed)");
  expect(calls).toBe(1);
  expect(delays).toEqual([]);
});

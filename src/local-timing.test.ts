import { expect, test } from "bun:test";
import { finishLocalTiming, localTimingEnvironment, localTimingSpan } from "./local-timing";

test("local timing preserves bucket results and concurrent IO parent attribution", async () => {
  const env = { CASTLOOP_BUCKET: { async get(key: string) {
    return { key, async text() { return `${this.key}-body`; } };
  } } };
  const measured = localTimingEnvironment(env, "test");
  await localTimingSpan(measured.env, "root", async () => {
    const [left, right] = await Promise.all([measured.env.CASTLOOP_BUCKET.get("left"), measured.env.CASTLOOP_BUCKET.get("right")]);
    expect(await left.text()).toBe("left-body");
    expect(await right.text()).toBe("right-body");
  });
  const report = JSON.parse(finishLocalTiming(measured.trace));
  expect(report.events).toHaveLength(5);
  expect(report.events.slice(1).every((event: { parent: number; ok: boolean }) => event.parent === 0 && event.ok)).toBe(true);
});

test("local timing rethrows the original error", async () => {
  const error = new Error("expected");
  const measured = localTimingEnvironment({ CASTLOOP_BUCKET: { async get() { throw error; } } }, "test");
  await expect(measured.env.CASTLOOP_BUCKET.get()).rejects.toBe(error);
  expect(measured.trace.events[0]!.ok).toBe(false);
});

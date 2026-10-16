import { expect, test } from "bun:test";
import { startSqliteTrialTail } from "./sqlite-tail";
import type { TailSocket } from "./worker-tail";

const version = "11111111-1111-4111-8111-111111111111", probe = "22222222-2222-4222-8222-222222222222";
class Socket extends EventTarget {
  send() {}
  ping(data: string) { this.dispatchEvent(new MessageEvent("pong", { data })); }
  close() { this.dispatchEvent(new Event("close")); }
  emit(value: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}
async function start(failCapture = false) {
  const socket = new Socket(), session = { id: "test", url: "wss://tail.invalid", expires_at: new Date(Date.now() + 60000).toISOString() };
  const tail = await startSqliteTrialTail({ create: async () => session, list: async () => [session], onHealth: () => {},
    onInvocation: () => { if (failCapture) throw new Error("disk unavailable"); }, socket: () => {
      queueMicrotask(() => socket.dispatchEvent(new Event("open"))); return socket as unknown as TailSocket;
    } });
  return { socket, tail };
}

test("integrated SQLite tail counts only exact-version outer probe CPU, not socket health or cache/DO CPU", async () => {
  const { socket, tail } = await start();
  const row = { outcome: "ok", cpuTime: 0, scriptVersion: { id: version }, event: { request: {
    url: "https://trial.invalid/podcasts/show/feed.xml", method: "GET", headers: { "X-Castloop-Probe": probe } }, response: { status: 200 } } };
  try {
    tail.assertHealthy(); expect(tail.hasProbeCpu(probe, version)).toBe(false);
    socket.emit({ ...row, entrypoint: "SqliteCachedAssets" }); expect(tail.hasProbeCpu(probe, version)).toBe(false);
    socket.emit(row); expect(tail.hasProbeCpu(probe, version)).toBe(true); expect(tail.hasProbeCpu(probe, probe)).toBe(false);
    socket.emit({ outcome: "canceled", entrypoint: "SqlitePublicationService", durableObjectId: "never-record", event: { scheduledTime: 1 } });
    expect(() => tail.assertCanMutate()).toThrow("reconciliation");
  } finally { tail.stop(); }
});

test("capture failures and fatal native outcomes cannot be hidden by a healthy socket", async () => {
  for (const failCapture of [false, true]) {
    const { socket, tail } = await start(failCapture);
    try { socket.emit({ outcome: failCapture ? "ok" : "exceededCpu" }); expect(() => tail.assertHealthy()).toThrow(); }
    finally { tail.stop(); }
  }
});

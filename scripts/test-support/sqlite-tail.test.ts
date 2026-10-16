import { expect, test } from "bun:test";
import { startSqliteTrialTail } from "./sqlite-tail";
import type { TailSocket } from "./worker-tail";
import type { SqliteCaptureFailure } from "./sqlite-tail";

const version = "11111111-1111-4111-8111-111111111111", probe = "22222222-2222-4222-8222-222222222222";
class Socket extends EventTarget {
  send() {}
  ping(data: string) { this.dispatchEvent(new MessageEvent("pong", { data })); }
  close() { this.dispatchEvent(new Event("close")); }
  emit(value: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}
async function start(failCapture = false) {
  const socket = new Socket(), session = { id: "test", url: "wss://tail.invalid", expires_at: new Date(Date.now() + 60000).toISOString() };
  const failures: SqliteCaptureFailure[] = [];
  const tail = await startSqliteTrialTail({ create: async () => session, list: async () => [session], onHealth: () => {},
    onCaptureFailure: (diagnostic) => { failures.push(diagnostic); },
    onInvocation: () => { if (failCapture) throw new Error("disk unavailable"); }, socket: () => {
      queueMicrotask(() => socket.dispatchEvent(new Event("open"))); return socket as unknown as TailSocket;
    } });
  return { socket, tail, failures };
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

test("serialized Alarm dates are captured, and rejected frames make measurement incomplete with safe diagnostics", async () => {
  const { socket, tail, failures } = await start();
  try {
    socket.emit({ outcome: "ok", entrypoint: "SqlitePublicationService", durableObjectId: "private", event: { scheduledTime: "2026-10-16T11:22:02.000Z" } });
    tail.assertHealthy(); expect(tail.rows[0]?.kind).toBe("do-alarm");
    socket.emit({ outcome: "ok", entrypoint: "SqlitePublicationService", durableObjectId: "private", event: { scheduledTime: "private invalid value" } });
    expect(() => tail.assertHealthy()).toThrow("capture failed");
    const summary = tail.stop(); expect(summary.capture_complete).toBe(false); expect(summary.rejected_frames).toBe(1);
    expect(failures).toEqual([{ event: "sqlite_tail_capture", reason_code: "frame_schema_unverified", fields: ["event.scheduledTime"] }]);
    expect(JSON.stringify(summary)).not.toContain("private");
  } finally { tail.stop(); }
});

test("capture failures and fatal native outcomes cannot be hidden by a healthy socket", async () => {
  for (const failCapture of [false, true]) {
    const { socket, tail } = await start(failCapture);
    try { socket.emit({ outcome: failCapture ? "ok" : "exceededCpu" }); expect(() => tail.assertHealthy()).toThrow(); }
    finally { tail.stop(); }
  }
});

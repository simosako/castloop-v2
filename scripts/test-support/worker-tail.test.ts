import { describe, expect, test } from "bun:test";
import { sanitizeTailInvocation, startWorkerTail } from "./worker-tail";
import type { TailHealth, TailSession, TailSocket } from "./worker-tail";

class FakeSocket extends EventTarget {
  sent: string[] = [];
  pings = 0;
  closed = false;
  answerPings = true;
  send(data: string) { this.sent.push(data); }
  ping(data: string) {
    this.pings++;
    if (this.answerPings) this.dispatchEvent(new MessageEvent("pong", { data: Buffer.from(data) }));
  }
  close() { this.closed = true; this.dispatchEvent(new CloseEvent("close", { code: 1000 })); }
  open() { this.dispatchEvent(new Event("open")); }
}

function fixture(expiresAt = new Date(Date.now() + 60000).toISOString()) {
  const session: TailSession = { id: "shared-tail", url: "wss://tail.invalid", expires_at: expiresAt };
  const socket = new FakeSocket();
  const health: TailHealth[] = [];
  let present = true;
  const options = { create: async () => session, list: async () => present ? [session] : [],
    socket: () => { queueMicrotask(() => socket.open()); return socket as unknown as TailSocket; },
    onHealth: (record: TailHealth) => { health.push(record); }, onInvocation: () => {},
    pingIntervalMs: 10, registryIntervalMs: 10, connectTimeoutMs: 100 };
  return { socket, health, options, remove: () => { present = false; } };
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

describe("test-only Worker tail collector", () => {
  test("closing one observer never deletes its shared remote session", async () => {
    const a = fixture(); const b = fixture();
    const first = await startWorkerTail(a.options);
    const second = await startWorkerTail(b.options);
    try {
      expect(first.summary().tail_id).toBe(second.summary().tail_id);
      second.stop();
      expect(b.socket.closed).toBe(true);
      expect(a.socket.closed).toBe(false);
      first.assertHealthy();
      expect(first.summary().complete).toBe(true);
      expect(a.socket.sent).toEqual(['{"debug":false}']);
    } finally { first.stop(); second.stop(); }
  });

  test("detects a deleted remote session even without a WebSocket close event", async () => {
    const setup = fixture(); const tail = await startWorkerTail(setup.options);
    try {
      setup.remove();
      await waitUntil(() => tail.summary().state === "failed");
      expect(tail.summary().reason_code).toBe("tail_session_removed");
      expect(() => tail.assertHealthy()).toThrow("preserve running mutations");
      expect(setup.socket.closed).toBe(false);
    } finally { tail.stop(); }
    expect(tail.summary().complete).toBe(false);
  });

  test("uses correlated ping/pong rather than treating quiet traffic as failure", async () => {
    const setup = fixture(); const tail = await startWorkerTail(setup.options);
    try {
      await waitUntil(() => setup.socket.pings >= 3);
      tail.assertHealthy();
      expect(tail.summary().invocation_count).toBe(0);
    } finally { tail.stop(); }
  });

  test("missing pong is sticky failure and blocks the next action without killing a live mutation", async () => {
    const setup = fixture(); setup.socket.answerPings = false;
    const tail = await startWorkerTail(setup.options);
    try {
      await waitUntil(() => tail.summary().state === "failed");
      setup.socket.dispatchEvent(new MessageEvent("pong", { data: "castloop test tail ping" }));
      expect(tail.summary().reason_code).toBe("tail_pong_timeout");
      expect(() => tail.assertHealthy()).toThrow();
      expect(setup.socket.closed).toBe(false);
    } finally { tail.stop(); }
  });

  test("expiry stops measurement even when the socket stays open", async () => {
    const setup = fixture(new Date(Date.now() + 80).toISOString());
    const tail = await startWorkerTail(setup.options);
    try {
      await waitUntil(() => tail.summary().state === "failed");
      expect(tail.summary().reason_code).toBe("tail_expired");
      expect(() => tail.assertHealthy()).toThrow();
    } finally { tail.stop(); }
  });

  test("records normal and abnormal unexpected closes as incomplete", async () => {
    for (const code of [1000, 1006]) {
      const setup = fixture(); const tail = await startWorkerTail(setup.options);
      setup.socket.dispatchEvent(new CloseEvent("close", { code }));
      expect(tail.summary().close_code).toBe(code);
      expect(tail.summary().complete).toBe(false);
      tail.stop();
    }
  });

  test("registry read failures and malformed frames invalidate the capture", async () => {
    const setup = fixture();
    const tail = await startWorkerTail({ ...setup.options, list: async () => { throw new Error("private response"); } });
    try {
      await waitUntil(() => tail.summary().state === "failed");
      expect(tail.summary().reason_code).toBe("tail_registry_unverified");
      expect(JSON.stringify(setup.health)).not.toContain("private response");
    } finally { tail.stop(); }
    const malformed = fixture(); const other = await startWorkerTail(malformed.options);
    malformed.socket.dispatchEvent(new MessageEvent("message", { data: "invalid-json" }));
    expect(other.summary().reason_code).toBe("tail_frame_or_capture_failed");
    other.stop();
  });

  test("failed file writes invalidate measurement instead of being silently ignored", async () => {
    const setup = fixture();
    const tail = await startWorkerTail({ ...setup.options, onInvocation: () => { throw new Error("disk failure"); } });
    setup.socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ outcome: "ok", logs: [] }) }));
    expect(tail.summary().complete).toBe(false);
    tail.stop();
  });

  test("strips raw requests, headers, exception messages and extra diagnostic fields", () => {
    const secret = "private-admin-key";
    const result = sanitizeTailInvocation(JSON.stringify({ outcome: "ok", cpuTime: 2, wallTime: 10,
      event: { request: { headers: { Authorization: secret } } },
      exceptions: [{ name: "Error", message: secret }],
      logs: [{ message: [secret, JSON.stringify({ event: "worker_timing", job_id: crypto.randomUUID(),
        phase: "publication.consumer", timing_id: crypto.randomUUID(), duration_ms: 10, outcome: "success", secret })] }],
    }));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.logs).toHaveLength(1);
    expect(result.exceptions).toEqual([{ name: "Error" }]);
  });

  test("truncated invocations are not complete measurements", async () => {
    const setup = fixture(); const tail = await startWorkerTail(setup.options);
    setup.socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ outcome: "ok", truncated: true }) }));
    expect(tail.summary().reason_code).toBe("tail_invocation_truncated");
    tail.stop();
  });

  test("keeps option C command timings without retaining raw content or credentials", () => {
    const jobId = crypto.randomUUID();
    const phases = ["management.stage-start", "management.upload-complete", "management.publish"];
    const result = sanitizeTailInvocation(JSON.stringify({ outcome: "ok", cpuTime: 20, wallTime: 100,
      logs: phases.map((phase) => ({ message: [JSON.stringify({ event: "worker_timing", job_id: jobId, phase,
        timing_id: crypto.randomUUID(), duration_ms: 50, outcome: "success", title: "private-title", token: "private-token" })] })) }));
    expect(result.logs.map((log) => log.phase)).toEqual(phases);
    expect(result.cpu_time).toBe(20);
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  test("a connection that never opens fails within its deadline", async () => {
    const setup = fixture();
    await expect(startWorkerTail({ ...setup.options, socket: () => setup.socket as unknown as TailSocket,
      connectTimeoutMs: 10 })).rejects.toThrow("tail_connect_timeout");
    expect(setup.socket.closed).toBe(true);
  });

  test("native Bun client ping receives a real server pong without new dependencies", async () => {
    const server = Bun.serve({ port: 0, fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("not upgraded", { status: 400 });
    }, websocket: { message() {} } });
    const session = { id: "local-tail", url: `ws://localhost:${server.port}`,
      expires_at: new Date(Date.now() + 60000).toISOString() };
    const tail = await startWorkerTail({ create: async () => session, list: async () => [session],
      onHealth() {}, onInvocation() {}, pingIntervalMs: 10, registryIntervalMs: 20 });
    try { await Bun.sleep(50); tail.assertHealthy(); }
    finally { tail.stop(); server.stop(true); }
  });
});

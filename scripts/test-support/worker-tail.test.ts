import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
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
    socket: () => { void Promise.resolve().then(() => socket.open()); return socket as unknown as TailSocket; },
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

  describe("heartbeat state machine", () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    test("uses correlated ping/pong rather than treating quiet traffic as failure", async () => {
      const setup = fixture(); const tail = await startWorkerTail(setup.options);
      try {
        jest.advanceTimersByTime(9);
        expect(setup.socket.pings).toBe(0);
        jest.advanceTimersByTime(1);
        expect(setup.socket.pings).toBe(1);
        jest.advanceTimersByTime(20);
        expect(setup.socket.pings).toBe(3);
        tail.assertHealthy();
        expect(tail.summary().invocation_count).toBe(0);
      } finally { tail.stop(); }
    });

    test("an asynchronous matching pong before the next tick permits another ping", async () => {
      const setup = fixture(); setup.socket.answerPings = false;
      const tail = await startWorkerTail(setup.options);
      try {
        jest.advanceTimersByTime(10);
        jest.advanceTimersByTime(9);
        tail.assertHealthy();
        setup.socket.dispatchEvent(new MessageEvent("pong", { data: Buffer.from("castloop test tail ping") }));
        jest.advanceTimersByTime(1);
        expect(setup.socket.pings).toBe(2);
        tail.assertHealthy();
      } finally { tail.stop(); }
    });

    test("missing pong is sticky failure and blocks the next action without killing a live mutation", async () => {
      const setup = fixture(); setup.socket.answerPings = false;
      const tail = await startWorkerTail(setup.options);
      try {
        jest.advanceTimersByTime(10);
        expect(setup.socket.pings).toBe(1);
        setup.socket.dispatchEvent(new MessageEvent("pong", { data: "unrelated pong" }));
        setup.socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ outcome: "ok" }) }));
        jest.advanceTimersByTime(9);
        tail.assertHealthy();
        jest.advanceTimersByTime(1);
        expect(tail.summary().reason_code).toBe("tail_pong_timeout");
        setup.socket.dispatchEvent(new MessageEvent("pong", { data: "castloop test tail ping" }));
        jest.advanceTimersByTime(100);
        expect(tail.summary().reason_code).toBe("tail_pong_timeout");
        expect(tail.summary().complete).toBe(false);
        expect(() => tail.assertHealthy()).toThrow("preserve running mutations");
        expect(setup.socket.pings).toBe(1);
        expect(setup.socket.closed).toBe(false);
      } finally { tail.stop(); }
      expect(tail.summary().complete).toBe(false);
    });

    test("stopping with a pending pong cancels further heartbeat checks", async () => {
      const setup = fixture(); setup.socket.answerPings = false;
      const tail = await startWorkerTail(setup.options);
      try {
        jest.advanceTimersByTime(10);
        tail.stop();
        jest.advanceTimersByTime(100);
        expect(setup.socket.pings).toBe(1);
        expect(tail.summary().state).toBe("stopped");
        expect(tail.summary().complete).toBe(true);
      } finally { tail.stop(); }
    });
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

  test.each([0, 25])("native Bun ping/pong control frames survive %ims loop delay", async (delayMs) => {
    const events: Array<{ event: "socket_open" | "ping_sent" | "pong_received" | "loop_resumed" | "transport_deadline";
      elapsed_ms: number }> = [];
    const started = performance.now();
    const record = (event: typeof events[number]["event"]) => events.push({ event, elapsed_ms: performance.now() - started });
    let rejectTransport: (error: Error) => void;
    const transportFailure = new Promise<never>((_, reject) => { rejectTransport = reject; });
    const withDeadline = async <T,>(operation: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([operation, transportFailure, new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            record("transport_deadline");
            reject(new Error(`Native tail transport deadline: ${JSON.stringify(events)}`));
          }, 2000);
        })]);
      } finally { clearTimeout(timer); }
    };
    let server: Bun.Server<undefined> | undefined;
    let socket: WebSocket | undefined;
    let acknowledgePong: (() => void) | undefined;
    const pingPayload = "castloop test tail ping";
    let serverPings = 0;
    let clientPongs = 0;
    try {
      server = Bun.serve<undefined>({ port: 0, fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("not upgraded", { status: 400 });
      }, websocket: { message() {}, ping() { serverPings++; } } });
      socket = new WebSocket(`ws://localhost:${server.port}`, "trace-v1");
      const transport = socket as unknown as TailSocket;
      transport.addEventListener("error", () => rejectTransport(new Error("Native tail socket error")));
      transport.addEventListener("close", () => rejectTransport(new Error("Native tail socket closed")));
      transport.addEventListener("pong", (event) => {
        const data = (event as { data: unknown }).data;
        if (!ArrayBuffer.isView(data) ||
          new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) !== pingPayload) return;
        record("pong_received"); clientPongs++;
        acknowledgePong?.();
      });
      await withDeadline(new Promise<void>((resolve) => {
        transport.addEventListener("open", () => { record("socket_open"); resolve(); });
      }));
      // Collector deadlines are tested above; native I/O must not race a 10 ms timer.
      for (let count = 1; count <= 3; count++) {
        const pong = new Promise<void>((resolve) => { acknowledgePong = resolve; });
        record("ping_sent"); transport.ping(pingPayload);
        const until = performance.now() + delayMs;
        while (performance.now() < until) {}
        record("loop_resumed");
        await withDeadline(pong);
        expect(serverPings).toBe(count);
        expect(clientPongs).toBe(count);
      }
    } finally {
      socket?.close(); server?.stop(true);
    }
  });
});

import { z } from "zod";

const sessionSchema = z.object({ id: z.string().min(1), url: z.url(), expires_at: z.iso.datetime() });
const diagnosticSchema = z.object({
  event: z.enum(["worker_phase_started", "worker_timing", "publication_delivery", "publication_execution_blocked"]),
  job_id: z.uuid(), phase: z.string().regex(/^(?:(publication|staging)\.[a-z_.]+|management\.(stage-start|upload-complete|publish))$/).optional(),
  timing_id: z.uuid().optional(), started_at: z.iso.datetime().optional(), finished_at: z.iso.datetime().optional(),
  duration_ms: z.number().finite().nonnegative().optional(), outcome: z.enum(["success", "error"]).optional(),
  delivered_at: z.iso.datetime().optional(), message_timestamp: z.iso.datetime().nullable().optional(),
  attempts: z.number().int().positive().nullable().optional(), reason_code: z.literal("retained_execution_token").optional(),
  authorizes_recovery: z.literal(false).optional(),
});
const invocationSchema = z.object({
  outcome: z.string().max(80), eventTimestamp: z.number().finite().nullable().optional(),
  cpuTime: z.number().finite().nonnegative().optional(), wallTime: z.number().finite().nonnegative().optional(),
  truncated: z.boolean().optional(), logs: z.array(z.object({ message: z.array(z.unknown()) })).default([]),
  exceptions: z.array(z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,79}$/).optional() })).default([]),
});

export type TailSession = z.infer<typeof sessionSchema>;
export type TailSocket = {
  send: (data: string) => void;
  ping: (data: string) => void;
  close: () => void;
  addEventListener: (event: string, listener: (value: unknown) => void) => void;
};
export type TailHealth = {
  event: "tail_health"; state: "connecting" | "connected" | "failed" | "stopped";
  tail_id: string; expires_at: string; recorded_at: string;
  reason_code?: string; close_code?: number; last_message_at?: string;
  invocation_count: number; complete: boolean;
};
export type WorkerTailOptions = {
  create: () => Promise<unknown>;
  list: () => Promise<unknown>;
  onHealth: (record: TailHealth) => void;
  onInvocation: (record: ReturnType<typeof sanitizeTailInvocation>) => void;
  socket?: (url: string) => TailSocket;
  pingIntervalMs?: number; registryIntervalMs?: number; connectTimeoutMs?: number;
};
export type WorkerTail = { assertHealthy: () => void; stop: () => void; summary: () => TailHealth };

export function sanitizeTailInvocation(data: unknown): {
  received_at: string; outcome: string; event_timestamp?: number | null;
  cpu_time?: number; wall_time?: number; truncated?: boolean;
  exceptions: Array<{ name?: string }>; logs: z.infer<typeof diagnosticSchema>[];
} {
  const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) :
    ArrayBuffer.isView(data) ? new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) : null;
  if (text === null) throw new Error("Unsupported tail frame");
  const row = invocationSchema.parse(JSON.parse(text));
  const logs = row.logs.flatMap((log) => log.message.flatMap((message) => {
    if (typeof message !== "string") return [];
    try {
      const parsed = diagnosticSchema.safeParse(JSON.parse(message));
      return parsed.success ? [parsed.data] : [];
    } catch { return []; }
  }));
  return { received_at: new Date().toISOString(), outcome: row.outcome, event_timestamp: row.eventTimestamp,
    cpu_time: row.cpuTime, wall_time: row.wallTime, truncated: row.truncated, exceptions: row.exceptions, logs };
}

export async function startWorkerTail(options: WorkerTailOptions): Promise<WorkerTail> {
  const session = sessionSchema.parse(await options.create());
  const expiration = Date.parse(session.expires_at);
  const socket = options.socket ? options.socket(session.url) : new WebSocket(session.url, "trace-v1") as unknown as TailSocket;
  const pingMessage = "castloop test tail ping";
  let state: TailHealth["state"] = "connecting";
  let failure: string | undefined;
  let closeCode: number | undefined;
  let lastMessageAt: string | undefined;
  let invocationCount = 0;
  let waitingForPong = false;
  let checkingRegistry = false;
  let stopped = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let resolveOpen: () => void;
  let rejectOpen: (reason: Error) => void;
  const opened = new Promise<void>((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
  const summary = (): TailHealth => ({ event: "tail_health", state, tail_id: session.id, expires_at: session.expires_at,
    recorded_at: new Date().toISOString(), ...(failure ? { reason_code: failure } : {}),
    ...(closeCode !== undefined ? { close_code: closeCode } : {}), last_message_at: lastMessageAt,
    invocation_count: invocationCount, complete: !failure });
  const recordHealth = () => {
    try { options.onHealth(summary()); }
    catch { failure ??= "tail_health_write_failed"; state = "failed"; }
  };
  const fail = (reason: string) => {
    if (stopped || failure) return;
    failure = reason; state = "failed"; recordHealth();
    rejectOpen(new Error(`Worker tail unavailable: ${reason}`));
  };
  const assertHealthy = () => {
    if (Date.now() >= expiration) fail("tail_expired");
    if (failure || state !== "connected") throw new Error(`Worker tail unavailable: ${failure ?? state}; preserve running mutations`);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    state = "stopped"; recordHealth();
    socket.close();
  };
  socket.addEventListener("message", (event) => {
    if (stopped) return;
    try {
      const row = sanitizeTailInvocation((event as { data: unknown }).data);
      options.onInvocation(row);
      invocationCount++; lastMessageAt = row.received_at;
      if (row.truncated) fail("tail_invocation_truncated");
    } catch { fail("tail_frame_or_capture_failed"); }
  });
  socket.addEventListener("pong", (event) => {
    const data = (event as { data: unknown }).data;
    const text = typeof data === "string" ? data : ArrayBuffer.isView(data) ?
      new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) : "";
    if (text === pingMessage) waitingForPong = false;
  });
  socket.addEventListener("close", (event) => {
    closeCode = (event as { code: number }).code;
    fail("tail_socket_closed");
  });
  socket.addEventListener("error", () => fail("tail_socket_error"));
  socket.addEventListener("open", () => {
    if (stopped) return;
    try {
      socket.send(JSON.stringify({ debug: false }));
      if (failure) return;
      state = "connected"; recordHealth();
      if (failure) { rejectOpen(new Error("Worker tail health capture failed")); return; }
      resolveOpen();
    } catch { fail("tail_handshake_failed"); }
  });
  recordHealth();
  const connectTimer = setTimeout(() => fail("tail_connect_timeout"), options.connectTimeoutMs ?? 10000);
  timers.push(connectTimer);
  try {
    await opened;
    clearTimeout(connectTimer);
    assertHealthy();
  } catch (error) { stop(); throw error; }
  timers.push(setInterval(() => {
    if (stopped || failure) return;
    if (waitingForPong) { fail("tail_pong_timeout"); return; }
    waitingForPong = true;
    try { socket.ping(pingMessage); } catch { fail("tail_ping_failed"); }
  }, options.pingIntervalMs ?? 10000));
  timers.push(setTimeout(() => fail("tail_expired"), Math.max(0, expiration - Date.now())));
  timers.push(setInterval(() => {
    if (stopped || failure || checkingRegistry) return;
    checkingRegistry = true;
    void options.list().then((value) => {
      if (stopped || failure) return;
      const sessions = z.array(z.object({ id: z.string(), expires_at: z.iso.datetime() })).parse(value);
      const current = sessions.find((tail) => tail.id === session.id);
      if (!current) fail("tail_session_removed");
      else if (Date.parse(current.expires_at) <= Date.now()) fail("tail_expired");
      else recordHealth();
    }).catch(() => fail("tail_registry_unverified")).finally(() => { checkingRegistry = false; });
  }, options.registryIntervalMs ?? 30000));
  return { assertHealthy, stop, summary };
}

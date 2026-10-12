import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.argv[2];
const worker = process.argv[3] ?? "castloop-rsstest-1012-r1-acb1fbca";
const base = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker}/tails`;
const headers = { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" };
const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
if (existsSync(join(directory, "tail-ready.json"))) throw new Error("Never replace an existing tail capture");
const created = await fetch(base, { method: "POST", headers, body: JSON.stringify({ filters: [] }), signal: AbortSignal.timeout(60000) });
const response = await created.json() as { success: boolean; errors?: { code: number }[]; result?: { id: string; url: string; expires_at: string } };
save("tail-create-status.json", { status: created.status, success: response.success, error_codes: response.errors?.map(row => row.code) });
if (!created.ok || !response.success || !response.result) throw new Error("Tail API failed; no mutation may start");
const session = response.result;
let socket: WebSocket | undefined;
let intentionalClose = false;
let count = 0;
try {
  socket = new WebSocket(session.url, "trace-v1");
  const active = socket;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Tail connection deadline")), 30000);
    active.addEventListener("open", () => {
      clearTimeout(timeout);
      active.send(JSON.stringify({ debug: false }));
      save("tail-ready.json", { connected_at: new Date().toISOString(), expires_at: session.expires_at, worker });
      resolve();
    });
    active.addEventListener("error", () => reject(new Error("Tail connection error")));
  });
  active.addEventListener("close", event => {
    if (!intentionalClose) save("tail-unexpected-close.json", { code: event.code, at: new Date().toISOString() });
  });
  active.addEventListener("message", async event => {
    try {
      const data = typeof event.data === "string" ? event.data : event.data instanceof Blob ? await event.data.text() : new TextDecoder().decode(event.data);
      const value = JSON.parse(data);
      const logs: unknown[] = [];
      for (const log of value.logs ?? []) {
        for (const message of log.message ?? []) {
          let row;
          try { row = typeof message === "string" ? JSON.parse(message) : message; } catch { continue; }
          if (!row || !["worker_timing", "publication_delivery"].includes(row.event)) continue;
          const allowed = row.event === "worker_timing"
            ? ["event", "job_id", "phase", "outcome", "started_at", "finished_at", "duration_ms"]
            : ["event", "job_id", "delivered_at", "message_timestamp", "attempts"];
          logs.push(Object.fromEntries(allowed.filter(key => row[key] !== undefined).map(key => [key, row[key]])));
        }
      }
      const kind = value.event?.queue ? "queue" : value.event?.request ? "http" : value.event?.rpcMethod ? "rpc" : "other";
      appendFileSync(join(directory, "worker-logs.jsonl"), JSON.stringify({ received_at: new Date().toISOString(), event_timestamp: value.eventTimestamp,
        kind, queue: kind === "queue" ? value.event.queue : undefined, batch_size: value.event?.batchSize,
        outcome: value.outcome, exception_count: value.exceptions?.length ?? 0, logs }) + "\n", { mode: 0o600 });
      count++;
    } catch {
      save("tail-capture-error.json", { at: new Date().toISOString(), reason: "message_decode_or_write_failed" });
    }
  });
  const start = performance.now();
  while (!existsSync(join(directory, "tail-stop"))) {
    if (performance.now() - start > 600000) throw new Error("Tail capture safety deadline");
    if (existsSync(join(directory, "tail-unexpected-close.json")) || existsSync(join(directory, "tail-capture-error.json"))) throw new Error("Tail capture interrupted");
    await Bun.sleep(200);
  }
  intentionalClose = true;
  active.close();
} finally {
  intentionalClose = true;
  socket?.close();
  const deleted = await fetch(base + "/" + session.id, { method: "DELETE", headers, signal: AbortSignal.timeout(60000) });
  const result = await deleted.json() as { success: boolean };
  save("tail-closed.json", { at: new Date().toISOString(), captured_invocations: count, http_status: deleted.status, success: result.success });
  if (!deleted.ok || !result.success) throw new Error("Tail session cleanup failed");
}

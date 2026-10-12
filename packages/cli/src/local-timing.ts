import { appendFileSync } from "node:fs";

function emit(value: object): void {
  const path = process.env.CASTLOOP_LOCAL_TIMING_FILE;
  if (path) {
    try { appendFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 }); } catch { /* Diagnostic only. */ }
  }
}

export async function localCliTimingSpan<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const at = Date.now();
  let ok = false;
  try { const result = await operation(); ok = true; return result; }
  finally { emit({ kind: "cli_span", label, started_at_ms: at, duration_ms: performance.now() - started, ok }); }
}

export function installLocalCliTiming(): void {
  if (!process.env.CASTLOOP_LOCAL_TIMING_FILE) return;
  const original = globalThis.fetch;
  const wrapped: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const started = performance.now();
    const at = Date.now();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (url.pathname.startsWith("/admin/")) headers.set("X-Castloop-Local-Timing", "1");
    let action: string | undefined;
    if (typeof init?.body === "string" && url.pathname.startsWith("/admin/")) {
      try { action = (JSON.parse(init.body) as { action?: string }).action; } catch { /* Diagnostic only. */ }
    }
    let response: Response;
    try { response = await original(input, { ...init, headers }); }
    catch (error) {
      emit({ kind: "http", host: url.hostname, path: url.pathname.replace(/\/accounts\/[^/]+\//, "/accounts/[account]/"),
        method: init?.method ?? "GET", action, started_at_ms: at, duration_ms: performance.now() - started, ok: false });
      throw error;
    }
    const server = response.headers.get("X-Castloop-Local-Timing");
    let worker: unknown;
    if (server) { try { worker = JSON.parse(Buffer.from(server, "base64").toString("utf8")); } catch { /* Diagnostic only. */ } }
    emit({ kind: "http", host: url.hostname, path: url.pathname.replace(/\/accounts\/[^/]+\//, "/accounts/[account]/"),
      method: init?.method ?? "GET", action, started_at_ms: at, ended_at_ms: Date.now(), duration_ms: performance.now() - started,
      status: response.status, cf_ray: response.headers.get("cf-ray"), worker });
    return response;
  }, original);
  globalThis.fetch = wrapped;
}

import type { R2RestTransport } from "../bounded-http-read";

export const TEST_LOOPBACK_ALLOWED_ORIGINS = ["https://api.cloudflare.com", "https://test-worker.example.workers.dev"];

export function loopbackTarget(request: Request, allowedOrigins: readonly string[] = TEST_LOOPBACK_ALLOWED_ORIGINS): string | null {
  const target = request.headers.get("X-Castloop-Test-Target");
  return target && allowedOrigins.includes(new URL(target).origin) ? target : null;
}

export function forwardLoopback(request: Request, target: string, transport: R2RestTransport): Promise<Response> {
  const headers = new Headers(request.headers); headers.delete("X-Castloop-Test-Target"); headers.delete("Host");
  return transport(target, { method: request.method, headers,
    ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }) });
}

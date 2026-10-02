import { readFileSync } from "node:fs";
import { join } from "node:path";

const calls: Array<{ method: string; path: string; action: unknown }> = [];
process.on("exit", () => { console.error(`OPERATION_STATUS_TEST_REQUESTS ${JSON.stringify(calls)}`); });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  const body = await request.json() as { action?: unknown };
  calls.push({ method: request.method, path: new URL(request.url).pathname, action: body.action });
  const fixture = JSON.parse(readFileSync(join(process.cwd(), "status-http-fixture.json"), "utf8")) as {
    url: string; request: unknown; response: unknown;
  };
  if (request.url !== fixture.url || request.method !== "POST" || body.action !== "status" ||
    JSON.stringify(body) !== JSON.stringify(fixture.request) || request.headers.get("X-Castloop-Key") !== "private-secret" ||
    init?.redirect !== "error" || init.cache !== "no-store") {
    throw new Error("Unexpected status request");
  }
  return Response.json(fixture.response, { headers: { "Cache-Control": "no-store" } });
}) as typeof fetch;

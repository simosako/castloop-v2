import { validateId } from "../packages/shared/src/ids";

type Env = {
  CASTLOOP_BUCKET: R2Bucket;
  CASTLOOP_ADMIN_KEY: string;
};

type ShowReservation = { show_id: string; reservation_id: string };

function authenticated(request: Request, secret: string): boolean {
  const received = new TextEncoder().encode(request.headers.get("X-Castloop-Key") ?? "");
  const expected = new TextEncoder().encode(secret);
  let difference = received.length ^ expected.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ (received[index] ?? 0);
  }
  return expected.length > 0 && difference === 0;
}

function json(data: object, status: number): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export default {
  async fetch(request, env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/admin/health" && request.method === "GET") {
      return authenticated(request, env.CASTLOOP_ADMIN_KEY)
        ? json({ result: "ready" }, 200) : json({ error: "unauthorized" }, 401);
    }
    if (pathname !== "/admin/shows/reserve" || request.method !== "POST") {
      return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    if (!authenticated(request, env.CASTLOOP_ADMIN_KEY)) return json({ error: "unauthorized" }, 401);
    if (Number(request.headers.get("Content-Length")) > 1024) return json({ error: "too large" }, 413);
    let input: unknown;
    try {
      const body = await request.text();
      if (body.length > 1024) return json({ error: "too large" }, 413);
      input = JSON.parse(body);
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: "invalid input" }, 400);
    const { show_id, reservation_id } = input as Record<string, unknown>;
    let showId: string;
    try {
      showId = validateId(show_id, "show");
    } catch {
      return json({ error: "invalid show ID" }, 400);
    }
    if (typeof reservation_id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(reservation_id)) {
      return json({ error: "invalid reservation ID" }, 400);
    }
    const key = `system/show-reservations/${showId}.json`;
    const value: ShowReservation = { show_id: showId, reservation_id };
    const current = await env.CASTLOOP_BUCKET.get(key);
    if (current) {
      const record: unknown = await current.json();
      return record && typeof record === "object" && "reservation_id" in record &&
        record.reservation_id === reservation_id
        ? json({ result: "already-reserved" }, 200)
        : json({ error: "show ID already reserved" }, 409);
    }
    const created = await env.CASTLOOP_BUCKET.put(key, JSON.stringify(value), {
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    if (created) return json({ result: "reserved" }, 201);
    const existing = await env.CASTLOOP_BUCKET.get(key);
    if (existing) {
      const record: unknown = await existing.json();
      if (record && typeof record === "object" && "reservation_id" in record &&
        record.reservation_id === reservation_id) return json({ result: "already-reserved" }, 200);
    }
    return json({ error: "show ID already reserved" }, 409);
  },
  async queue(batch): Promise<void> {
    console.error(JSON.stringify({ event: "unimplemented_publication", queue: batch.queue,
      messages: batch.messages.length }));
    throw new Error("Publication consumer is not yet implemented");
  },
} satisfies ExportedHandler<Env>;

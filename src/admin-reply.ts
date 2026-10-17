export function adminReply(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function adminReplyHeadAware(request: Request, data: object, status: number): Response {
  return new Response(request.method === "HEAD" ? null : JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

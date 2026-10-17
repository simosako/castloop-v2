import { expect, test } from "bun:test";
import { adminReply, adminReplyHeadAware } from "./admin-reply";

test("administrative JSON responses preserve status and prohibit caching", async () => {
  for (const status of [200, 202, 400, 401, 409, 503]) {
    const response = adminReply({ result: "番組" }, status);
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.text()).toBe(JSON.stringify({ result: "番組" }));
  }
});

test("HEAD-aware routing preserves its explicit JSON charset and omits the body", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = adminReplyHeadAware(new Request("https://example.invalid/admin", { method }), { error: "unauthorized" }, 401);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(await response.text()).toBe(method === "HEAD" ? "" : '{"error":"unauthorized"}');
    if (method === "HEAD") expect(response.body).toBeNull();
  }
});

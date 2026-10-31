import { expect, test } from "bun:test";
import { adminReply } from "./admin-reply";

test("administrative JSON responses preserve status and prohibit caching", async () => {
  for (const status of [200, 503]) {
    const response = adminReply({ result: "番組" }, status);
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.text()).toBe(JSON.stringify({ result: "番組" }));
  }
});

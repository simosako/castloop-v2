import { expect, test } from "bun:test";
import { sqliteRequestObjectName, sqliteShowObjectName } from "./sqlite-show-routing";

test("publication, operation, target and Show control requests route directly to the explicit Show", () => {
  for (const path of ["/admin/sqlite-publication/status", "/admin/sqlite-publication/jobs", "/admin/sqlite-operations/commands",
    "/admin/sqlite-service/targets/daily", "/admin/sqlite-service/pause", "/admin/sqlite-service/resume"]) {
    expect(sqliteRequestObjectName(new Request(`https://example.com${path}`, { headers: { "X-Castloop-Show-Id": "daily" } }), "service")).toBe("show/service/daily");
  }
  expect(sqliteRequestObjectName(new Request("https://example.com/admin/sqlite-service/health"), "service")).toBe("service/service");
});

test("public delivery uses the approved path, never an injected Show header or the control DO", () => {
  for (const path of ["/podcasts/daily/feed.xml", "/podcasts/daily/cover.jpg", `/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`,
    "/podcasts/daily/", "/podcasts/daily/page/2/", "/podcasts/daily/episodes/first/"]) {
    expect(sqliteRequestObjectName(new Request(`https://example.com${path}`, { headers: { "X-Castloop-Show-Id": "other" } }), "service")).toBe("show/service/daily");
  }
});

test("invalid or empty Show scopes cannot select arbitrary namespace names", () => {
  for (const showId of ["../other", "a/b", "A", "x".repeat(33), ""]) {
    expect(() => sqliteRequestObjectName(new Request("https://example.com/admin/sqlite-service/health", { headers: { "X-Castloop-Show-Id": showId } }), "service")).toThrow();
  }
  expect(() => sqliteShowObjectName("service/other", "daily")).toThrow();
});

import { expect, test } from "bun:test";
import { CONTENT_LIST_PAGE_SIZE, contentListRequestSchema, contentListResponseSchema, serviceAdmissionSchema, stringifyToml } from "../packages/shared/src/index";
import type { ContentListRequest, LifecycleState } from "../packages/shared/src/index";
import { ContentListClient, formatContentList } from "../packages/cli/src/content-list";
import { handleM6ContentList } from "./content-list-admin";
import { claimShowOperation, readShowControl } from "./lifecycle-control";
import { fetchM6Candidate, fetchM6ManagementIntegration } from "./m6-routes";
import type { M6CachedLoopback, M6CandidateEnv } from "./m6-routes";
import { SERVICE_ADMISSION_KEY } from "./service-admission";
import { PUBLICATION_SHOW_TEXT } from "./test-support/publication";
import { stagingAdminFixture } from "./test-support/staging-admin";

async function fixture() {
  const setup = await stagingAdminFixture();
  const input = (showId?: string): ContentListRequest => ({ schema_version: 1, service_id: setup.config.service_id, include_deleted: false,
    ...(showId === undefined ? { kind: "show" } : { kind: "episode", show_id: showId }) });
  const request = (body: unknown, key = "private-secret", method = "POST") => new Request("https://current.example/admin/catalog", {
    method, headers: { "X-Castloop-Key": key }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  const call = async (body: unknown) => {
    const response = await handleM6ContentList(request(body), setup.env, setup.bindings);
    if (!response) throw new Error("Catalog route was not handled");
    return response;
  };
  const client = new ContentListClient(setup.config, "private-secret", async (url, init) => {
    const response = await handleM6ContentList(new Request(url, init), setup.env, setup.bindings);
    if (!response) throw new Error("Catalog route was not handled");
    return response;
  });
  const addShow = async (showId: string, lifecycle: LifecycleState) => {
    await setup.bucket.put(`system/show-publications/${showId}.json`, JSON.stringify({ schema_version: 2, show_id: showId,
      lifecycle, generation: 0, feed_generation: 0 }));
    await setup.bucket.put(`system/shows/${showId}/show.toml`, PUBLICATION_SHOW_TEXT.replace("'daily'", `'${showId}'`));
  };
  return { ...setup, input, request, call, client, addShow };
}

test("Show listing uses controls, includes drafts/stopped/deleting Shows, and never writes or returns private payload fields", async () => {
  const setup = await fixture();
  for (const lifecycle of ["draft", "unpublished", "deleting", "deleted"] as const) await setup.addShow(lifecycle, lifecycle);
  await setup.bucket.put("system/shows/orphan/show.toml", PUBLICATION_SHOW_TEXT.replace("'daily'", "'orphan'"));
  const before = [...setup.entries];
  const writes = [...setup.writes];
  const result = await setup.client.list(setup.input());
  if (!("shows" in result)) throw new Error("Expected Show catalog");
  expect(result.shows.map((item) => item.show_id)).toEqual(["daily", "deleting", "draft", "unpublished"]);
  expect(result.shows[0]).toMatchObject({ lifecycle: "active", title: "New Show title", unfinished_operation: false,
    feed_url: "https://current.example/podcasts/daily/feed.xml" });
  expect(result.shows.find((item) => item.show_id === "draft")?.title).toBeNull();
  expect(result.shows.find((item) => item.show_id === "deleting")?.title).toBeNull();
  const all = await setup.client.list({ ...setup.input(), include_deleted: true });
  if (!("shows" in all)) throw new Error("Expected Show catalog");
  expect(all.shows.find((item) => item.show_id === "deleted")?.title).toBeNull();
  expect(result.snapshot_only).toBe(true);
  expect(result.authorizes_operation).toBe(false);
  expect(JSON.stringify(all)).not.toContain("Private description");
  expect(JSON.stringify(all)).not.toContain("owner@example.com");
  expect(setup.writes).toEqual(writes);
  expect([...setup.entries]).toEqual(before);
});

test("Episode listing stays within the requested Show and reports parent/service state separately without reading audio/history", async () => {
  const setup = await fixture();
  for (const lifecycle of ["draft", "active", "unpublished", "deleting", "deleted"] as const) await setup.addEpisode(lifecycle, lifecycle);
  await setup.bucket.put("system/episode-lifecycle/other/private.toml", "invalid unrelated data");
  const control = (await readShowControl(setup.env, "daily"))!.value;
  await setup.bucket.put("system/show-publications/daily.json", JSON.stringify({ ...control, lifecycle: "unpublished" }));
  await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify(serviceAdmissionSchema.parse(
    { ...setup.service, state: "paused", pause_id: crypto.randomUUID(), generation: 1 })));
  setup.bodyReads.length = 0;
  const writes = [...setup.writes];
  const result = await setup.client.list(setup.input("daily"));
  if (!("episodes" in result)) throw new Error("Expected Episode catalog");
  expect(result.admission_state).toBe("paused");
  expect(result.show).toEqual({ show_id: "daily", lifecycle: "unpublished", unfinished_operation: false });
  expect(result.episodes.map((item) => item.episode_id)).toEqual(["active", "deleting", "draft", "unpublished"]);
  expect(result.episodes[0]).toMatchObject({ title: "Saved active", published_at: "2026-09-01T12:34:56+09:00" });
  expect(formatContentList(result)).toContain("Parent Show/service is not serving");
  expect(setup.bodyReads.some((key) => key.endsWith(".mp3") || key.includes("/revisions/") || key.includes("/other/"))).toBe(false);
  const all = await setup.client.list({ ...setup.input("daily"), include_deleted: true });
  if (!("episodes" in all)) throw new Error("Expected Episode catalog");
  expect(all.episodes.find((item) => item.episode_id === "deleted")).toMatchObject({ title: null, published_at: null });
  expect(setup.writes).toEqual(writes);
  expect((await setup.call(setup.input("missing"))).status).toBe(404);
});

test("pagination remains bounded and continues even when filtering leaves an empty page", async () => {
  const setup = await fixture();
  for (let index = 0; index < CONTENT_LIST_PAGE_SIZE; index += 1) await setup.addShow(`a${String(index).padStart(2, "0")}`, "deleted");
  const first = await setup.client.list(setup.input());
  if (!("shows" in first)) throw new Error("Expected Show catalog");
  expect(first.shows).toEqual([]);
  expect(first.next_cursor).not.toBeNull();
  expect(formatContentList(first)).toContain("More records:");
  const second = await setup.client.list({ ...setup.input(), cursor: first.next_cursor! });
  if (!("shows" in second)) throw new Error("Expected Show catalog");
  expect(second.shows.map((item) => item.show_id)).toEqual(["daily"]);
  expect(second.next_cursor).toBeNull();
  const all = await setup.client.list({ ...setup.input(), include_deleted: true });
  if (!("shows" in all)) throw new Error("Expected Show catalog");
  expect(all.shows.length).toBe(CONTENT_LIST_PAGE_SIZE);
});

test("R2 truncated, not item count, controls continuation for short pages", async () => {
  const setup = await fixture();
  await setup.addShow("second", "draft");
  const limits: Array<number | undefined> = [];
  const env = { ...setup.env, CASTLOOP_BUCKET: { ...setup.bucket, list: async (options: Parameters<typeof setup.bucket.list>[0]) => {
    limits.push(options.limit);
    return setup.bucket.list({ ...options, limit: 1 });
  } } };
  const response = await handleM6ContentList(setup.request(setup.input()), env as never, setup.bindings);
  const result = contentListResponseSchema.parse(await response!.json());
  expect(limits).toEqual([CONTENT_LIST_PAGE_SIZE]);
  expect(result.next_cursor).toBe("1");
});

test("missing, malformed, oversized and mismatched summaries remain unavailable rather than changing lifecycle", async () => {
  const setup = await fixture();
  await setup.addShow("long-title", "active");
  await setup.bucket.put("system/shows/long-title/show.toml", PUBLICATION_SHOW_TEXT.replace("'daily'", "'long-title'")
    .replace("New Show title", "😀".repeat(150)));
  for (const id of ["missing", "malformed", "oversized", "mismatched"]) await setup.addEpisode(id, "active");
  setup.entries.delete("public/episodes/daily/missing/metadata.toml");
  await setup.bucket.put("public/episodes/daily/malformed/metadata.toml", "not valid TOML");
  await setup.bucket.put("public/episodes/daily/oversized/metadata.toml", "x".repeat(16385));
  const wrong = await setup.addEpisode("wrong", "active");
  if (!wrong) throw new Error("Expected fixture revision");
  await setup.bucket.put("public/episodes/daily/mismatched/metadata.toml", stringifyToml(wrong));
  const result = await setup.client.list(setup.input("daily"));
  if (!("episodes" in result)) throw new Error("Expected Episode catalog");
  for (const id of ["missing", "malformed", "oversized", "mismatched"]) {
    expect(result.episodes.find((item) => item.episode_id === id)).toMatchObject({ lifecycle: "active", title: null, published_at: null });
  }
  const shows = await setup.client.list(setup.input());
  if (!("shows" in shows)) throw new Error("Expected Show catalog");
  expect(shows.shows.find((item) => item.show_id === "long-title")?.title).toBe("😀".repeat(100));
});

test("unfinished ownership suppresses summaries and is never released by listing", async () => {
  const setup = await fixture();
  await setup.addEpisode("first", "active");
  await claimShowOperation(setup.env, { schema_version: 1, job_id: crypto.randomUUID(), kind: "episode", show_id: "daily", episode_id: "first",
    action: "stage", expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation,
    expected_episode_generation: 0, created_at: "2026-10-04T12:00:00Z" });
  const before = [...setup.entries];
  const writes = [...setup.writes];
  setup.bodyReads.length = 0;
  const result = await setup.client.list(setup.input("daily"));
  if (!("episodes" in result)) throw new Error("Expected Episode catalog");
  expect(result.show.unfinished_operation).toBe(true);
  expect(result.episodes[0]?.title).toBeNull();
  expect(setup.bodyReads.some((key) => key.includes("metadata.toml"))).toBe(false);
  expect(setup.writes).toEqual(writes);
  expect([...setup.entries]).toEqual(before);
});

test("catalog authentication, strict requests, runtime and exact client identity use the existing read-only gates", async () => {
  const setup = await fixture();
  expect((await handleM6ContentList(setup.request(setup.input(), "wrong"), setup.env, setup.bindings))?.status).toBe(401);
  expect((await handleM6ContentList(setup.request(setup.input(), "private-secret", "GET"), setup.env, setup.bindings))?.status).toBe(405);
  for (const body of [{ ...setup.input(), kind: "episode" }, { ...setup.input(), service_id: "other" },
    { ...setup.input(), show_id: "daily" }, { ...setup.input("daily"), show_id: "../other" }, { ...setup.input(), cursor: "x".repeat(4097) }]) {
    expect((await setup.call(body)).status).toBe(400);
  }
  expect(() => contentListRequestSchema.parse({ ...setup.input(), unexpected: true })).toThrow();
  const result = await setup.client.list(setup.input());
  const mismatched = new ContentListClient(setup.config, "private-secret", async () => Response.json(
    { ...result, request: { ...result.request, include_deleted: true } }, { headers: { "Cache-Control": "no-store" } }));
  await expect(mismatched.list(setup.input())).rejects.toThrow("exact request");
  expect(() => contentListResponseSchema.parse({ ...result, authorizes_operation: true })).toThrow();
  const bindings = { ...setup.bindings, versionMetadata: { id: crypto.randomUUID() } };
  expect((await handleM6ContentList(setup.request(setup.input()), setup.env, bindings))?.status).toBe(409);
});

test("formal Worker routing exposes catalog only through the management integration", async () => {
  const setup = await fixture();
  const loopback = Object.assign(() => ({ fetch: async () => new Response("unused") }), {
    invalidate: async () => {}, describeRuntime: setup.bindings.cachedAssets.describeRuntime,
  }) satisfies M6CachedLoopback;
  const env: M6CandidateEnv = { ...setup.env, CASTLOOP_DLQ_NAME: setup.config.dlq_name,
    CASTLOOP_VERSION_METADATA: { id: setup.versionId, tag: "", timestamp: "2026-10-04T12:00:00Z" },
    CASTLOOP_QUEUE: { send: async () => {} } } as never;
  expect((await fetchM6Candidate(setup.request(setup.input()), env, loopback)).status).not.toBe(200);
  const response = await fetchM6ManagementIntegration(setup.request(setup.input("daily")), env, loopback);
  expect(response.status).toBe(200);
  expect(contentListResponseSchema.parse(await response.json()).request.kind).toBe("episode");
});

import { describe, expect, test } from "bun:test";
import { stringifyLifecycleToml } from "../packages/shared/src/index";
import { fetchM6ManagementIntegration } from "./m6-routes";
import type { M6CandidateEnv, M6CachedLoopback } from "./m6-routes";
import { publicDeliveryMetadata, putPublicDeliveryRecord } from "./public-delivery-records";
import { readPublicDeliverySnapshot } from "./public-delivery-state";
import { PUBLICATION_SERVICE_TEXT } from "./test-support/publication";

const serviceKey = "system/lifecycle-service.json";
const configKey = "system/service.toml";
const showKey = "system/show-publications/daily.json";
const episodeKey = "system/episode-lifecycle/daily/first.toml";
const workerVersionId = crypto.randomUUID();
const readiness = { operation_id: crypto.randomUUID(), deployment_id: crypto.randomUUID(), worker_version_id: workerVersionId,
  service_config_sha256: "a".repeat(64), default_cache_disabled: true, cached_entrypoint: "CachedPublicAssets",
  cutover_verified: true, publication_routes_verified: true };

function service(state = "open") {
  return JSON.stringify({ schema_version: 1, service_id: "service", generation: 1, mode: "m6", state, invocations: [],
    ...(state === "paused" ? { pause_id: crypto.randomUUID() } : {}), runtime_readiness: readiness });
}

function show(lifecycle = "active", generation = 2, feedGeneration = 3) {
  return JSON.stringify({ schema_version: 2, show_id: "daily", lifecycle, generation, feed_generation: feedGeneration });
}

function episode(lifecycle: "active" | "unpublished" | "deleting" | "deleted" = "active", generation = 4) {
  return stringifyLifecycleToml({ schema_version: 1, show_id: "daily", episode_id: "first", lifecycle, generation });
}

async function fixture() {
  const entries = new Map<string, { size: number; etag: string; customMetadata?: Record<string, string>; source: string }>();
  const heads: string[] = [];
  let version = 0;
  const bucket = {
    async head(key: string) { heads.push(key); const object = entries.get(key); return object ? { key, ...object } : null; },
    async get() { throw new Error("Public HTTP must not read record bodies"); },
    async put(key: string, source: string, options: R2PutOptions) {
      const current = entries.get(key);
      if (options.onlyIf instanceof Headers ? Boolean(current) : options.onlyIf?.etagMatches !== current?.etag) return null;
      const object = { source, size: new TextEncoder().encode(source).length, etag: String(++version), customMetadata: options.customMetadata };
      entries.set(key, object);
      return { key, ...object };
    },
  };
  const env = { CASTLOOP_BUCKET: bucket, CASTLOOP_DLQ_NAME: "test-dlq", CASTLOOP_ADMIN_KEY: "private-key",
    CASTLOOP_VERSION_METADATA: { id: workerVersionId } } as unknown as M6CandidateEnv;
  const write = async (key: string, source: string) => {
    const current = entries.get(key);
    return await putPublicDeliveryRecord(env, key, source,
      { onlyIf: current ? { etagMatches: current.etag } : new Headers({ "If-None-Match": "*" }) });
  };
  await write(configKey, PUBLICATION_SERVICE_TEXT);
  await write(serviceKey, service());
  await write(showKey, show());
  await write(episodeKey, episode());
  const props: object[] = [];
  const loopback = Object.assign(({ props: input }: { props: object }) => ({ async fetch(request: Request) {
    props.push(input);
    return new Response(request.method === "HEAD" ? null : "cached feed", {
      headers: { "Cache-Control": "public,max-age=300", "Cache-Tag": "internal" },
    });
  } }), { async invalidate() {}, async describeRuntime() { throw new Error("Public HTTP must not probe the runtime"); } }) satisfies M6CachedLoopback;
  const fetch = (path = "/podcasts/daily/feed.xml", method = "GET") => fetchM6ManagementIntegration(
    new Request(`https://public.example${path}`, { method }), env, loopback);
  return { entries, env, heads, props, write, fetch };
}

describe("precomputed public delivery metadata", () => {
  test("warm public feed uses only three fresh HEADs and never reads or parses control bodies", async () => {
    const setup = await fixture();
    for (let index = 0; index < 3; index += 1) {
      const response = await setup.fetch();
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("cached feed");
      expect(response.headers.get("X-Castloop-Worker-Version")).toBe(workerVersionId);
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
      expect(response.headers.has("Cache-Tag")).toBe(false);
    }
    expect(setup.heads).toEqual(Array.from({ length: 3 }, () => [serviceKey, configKey, showKey]).flat());
    expect(setup.props).toEqual(Array.from({ length: 3 }, () => ({ showGeneration: 2, feedGeneration: 3 })));
  });

  test("Show lifecycle and feed generations replace metadata atomically for feed, cover and historical audio", async () => {
    const setup = await fixture();
    expect((await setup.fetch()).status).toBe(200);
    await setup.write(showKey, show("active", 5, 8));
    expect((await setup.fetch()).status).toBe(200);
    expect(setup.props.at(-1)).toEqual({ showGeneration: 5, feedGeneration: 8 });
    for (const [state, status] of [["unpublished", 404], ["deleting", 410], ["deleted", 410]] as const) {
      await setup.write(showKey, show(state, 6, 8));
      for (const path of ["/podcasts/daily/feed.xml", "/podcasts/daily/cover.jpg", `/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`]) {
        for (const method of ["GET", "HEAD"]) expect((await setup.fetch(path, method)).status).toBe(status);
      }
    }
    expect(setup.props).toHaveLength(2);
  });

  test("Episode updates gate every immutable revision and restore with its current generation", async () => {
    const setup = await fixture();
    const path = `/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`;
    expect((await setup.fetch(path)).status).toBe(200);
    expect(setup.props.at(-1)).toEqual({ showGeneration: 2, episodeGeneration: 4 });
    for (const [state, status] of [["unpublished", 404], ["deleting", 410], ["deleted", 410]] as const) {
      await setup.write(episodeKey, episode(state, 5));
      expect((await setup.fetch(path)).status).toBe(status);
    }
    await setup.write(episodeKey, episode("active", 6));
    expect((await setup.fetch(path)).status).toBe(200);
    expect(setup.props.at(-1)).toEqual({ showGeneration: 2, episodeGeneration: 6 });
  });

  test("pause, runtime mismatch, wrong service and wrong DLQ fail closed before cache access", async () => {
    for (const fault of ["pause", "version", "service", "dlq", "url-change"] as const) {
      const setup = await fixture();
      if (fault === "pause") await setup.write(serviceKey, service("paused"));
      else if (fault === "version") setup.env.CASTLOOP_VERSION_METADATA.id = crypto.randomUUID();
      else if (fault === "service") await setup.write(configKey, PUBLICATION_SERVICE_TEXT.replace("service_id = 'service'", "service_id = 'other'"));
      else if (fault === "dlq") setup.env.CASTLOOP_DLQ_NAME = "wrong-dlq";
      else setup.entries.get(serviceKey)!.customMetadata!.castloop_visibility = "closed";
      expect((await setup.fetch()).status).toBe(503);
      expect(setup.props).toEqual([]);
    }
  });

  test("missing or unknown metadata never falls back to body parsing or a cached response", async () => {
    const variants: Array<Record<string, string> | undefined> = [undefined, {}, { castloop_delivery: "unknown-v2" }];
    for (const key of [configKey, serviceKey, showKey, episodeKey]) {
      for (const metadata of variants) {
        const setup = await fixture();
        setup.entries.get(key)!.customMetadata = metadata;
        expect((await setup.fetch(`/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`)).status).toBe(503);
        expect(setup.props).toEqual([]);
      }
    }
  });

  test("malformed IDs, visibility and generations cannot produce cache props", async () => {
    for (const [name, value] of [["castloop_show_id", "other"], ["castloop_visibility", "active"],
      ["castloop_show_generation", "-1"], ["castloop_show_generation", "01"], ["castloop_feed_generation", "NaN"],
      ["castloop_feed_generation", "9007199254740992"]]) {
      const setup = await fixture();
      setup.entries.get(showKey)!.customMetadata![name!] = value!;
      expect((await setup.fetch()).status).toBe(503);
      expect(setup.props).toEqual([]);
    }
  });

  test("an unsuccessful CAS preserves both the previous body and its delivery metadata", async () => {
    const setup = await fixture();
    const before = structuredClone(setup.entries.get(showKey));
    expect(await putPublicDeliveryRecord(setup.env, showKey, show("unpublished"), { onlyIf: { etagMatches: "wrong" } })).toBeNull();
    expect(setup.entries.get(showKey)).toEqual(before);
    expect((await setup.fetch()).status).toBe(200);
  });

  test("management generation rejects invalid source before writing and retains only allowlisted delivery fields", async () => {
    const setup = await fixture();
    const before = structuredClone(setup.entries.get(showKey));
    for (const source of ["{}", show().replace('"daily"', '"other"'), show().replace('"active"', '"invalid"')]) {
      await expect(setup.write(showKey, source)).rejects.toThrow();
      expect(setup.entries.get(showKey)).toEqual(before);
    }
    expect(publicDeliveryMetadata(configKey, PUBLICATION_SERVICE_TEXT)).toEqual({ castloop_delivery: "config-v1",
      castloop_service_id: "service", castloop_dlq_name: "test-dlq" });
    await expect(putPublicDeliveryRecord(setup.env, showKey, show(), {})).rejects.toThrow("conditional");
    await expect(putPublicDeliveryRecord(setup.env, showKey, show(), { onlyIf: {} })).rejects.toThrow("conditional");
  });

  test("missing controls distinguish unknown content from reserved and orphaned content", async () => {
    const setup = await fixture();
    setup.entries.delete(episodeKey);
    expect(await readPublicDeliverySnapshot(setup.env, "daily", "first")).toEqual({ visibility: "not_found" });
    setup.entries.set("public/episodes/daily/first/metadata.toml", { source: "private", size: 7, etag: "orphan" });
    await expect(readPublicDeliverySnapshot(setup.env, "daily", "first")).rejects.toThrow("no public delivery control");
    setup.entries.delete(showKey);
    expect(await readPublicDeliverySnapshot(setup.env, "daily")).toEqual({ visibility: "not_found" });
    setup.entries.set("system/show-reservations/daily.json", { source: "reserved", size: 8, etag: "reserved" });
    await expect(readPublicDeliverySnapshot(setup.env, "daily")).rejects.toThrow("no public delivery control");
  });
});

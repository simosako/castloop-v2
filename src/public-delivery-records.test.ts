import { describe, expect, test } from "bun:test";
import { stringifyLifecycleToml } from "../packages/shared/src/index";
import { preparePublicDeliveryConfiguration, preparePublicDeliveryControls, publicDeliveryMetadata } from "./public-delivery-records";
import { readPublicDeliverySnapshot } from "./public-delivery-state";
import { migrationFixture } from "./test-support/migration";
import { PUBLICATION_SERVICE_TEXT } from "./test-support/publication";

const showKey = "system/show-publications/daily.json";
const showSource = JSON.stringify({ schema_version: 2, show_id: "daily", lifecycle: "active", generation: 5, feed_generation: 3 });

async function fixture() {
  const setup = await migrationFixture();
  setup.entries.clear();
  setup.writes.length = 0;
  await setup.bucket.put(showKey, showSource);
  return setup;
}

describe("owned public delivery projection preparation", () => {
  test("paginated preparation validates old records, preserves their bytes and is idempotent", async () => {
    const setup = await fixture();
    for (let index = 0; index < 101; index += 1) {
      await setup.bucket.put(`system/episode-lifecycle/daily/ep-${index}.toml`, stringifyLifecycleToml({ schema_version: 1,
        show_id: "daily", episode_id: `ep-${index}`, lifecycle: index === 100 ? "deleted" : "active", generation: index }));
    }
    const before = new Map(setup.entries);
    let ownerChecks = 0;
    await preparePublicDeliveryControls(setup.env, async () => { ownerChecks += 1; });
    expect(ownerChecks).toBeGreaterThan(103);
    for (const [key, entry] of before) {
      expect(setup.entries.get(key)!.data).toBe(entry.data);
      expect(setup.entries.get(key)!.size).toBe(entry.size);
      expect(setup.entries.get(key)!.customMetadata).toEqual(publicDeliveryMetadata(key, entry.data));
    }
    expect(await readPublicDeliverySnapshot(setup.env, "daily", "ep-100")).toEqual({ visibility: "gone" });
    const writes = [...setup.writes];
    await preparePublicDeliveryControls(setup.env, async () => {});
    expect(setup.writes).toEqual(writes);
  });

  test("losing the owner before a projection write does not change the source or generate permission", async () => {
    const setup = await fixture();
    const before = new Map(setup.entries);
    let checks = 0;
    await expect(preparePublicDeliveryControls(setup.env, async () => {
      if (++checks === 2) throw new Error("Owner changed");
    })).rejects.toThrow("Owner changed");
    expect(setup.entries).toEqual(before);
  });

  test("a competing source update wins and a stale projection cannot overwrite it", async () => {
    const setup = await fixture();
    const changed = showSource.replace('"generation":5', '"generation":6');
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
      await setup.bucket.put(showKey, changed);
      return await setup.bucket.put(...args);
    } } } as never;
    await expect(preparePublicDeliveryControls(env, async () => {})).rejects.toThrow("changed during preparation");
    expect(setup.entries.get(showKey)!.data).toBe(changed);
    expect(setup.entries.get(showKey)!.customMetadata).toBeUndefined();
  });

  test("preparation never trusts existing metadata over an invalid management source", async () => {
    const setup = await fixture();
    await setup.bucket.put(showKey, "{}", { customMetadata: publicDeliveryMetadata(showKey, showSource) });
    const before = new Map(setup.entries);
    await expect(preparePublicDeliveryControls(setup.env, async () => {})).rejects.toThrow();
    expect(setup.entries).toEqual(before);
  });

  test("unrecognized control keys and non-advancing inventory cursors stop preparation", async () => {
    const setup = await fixture();
    await setup.bucket.put("system/show-publications/unknown.txt", showSource);
    await expect(preparePublicDeliveryControls(setup.env, async () => {})).rejects.toThrow("Unknown public delivery source key");
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async list() {
      return { objects: [], truncated: true, cursor: "same" };
    } } } as never;
    await expect(preparePublicDeliveryControls(env, async () => {})).rejects.toThrow("cursor did not advance");
  });

  test("configuration projection requires the verified service and exact source ETag", async () => {
    const setup = await fixture();
    const key = "system/service.toml";
    await setup.bucket.put(key, PUBLICATION_SERVICE_TEXT);
    const before = new Map(setup.entries);
    await expect(preparePublicDeliveryConfiguration(setup.env, "other")).rejects.toThrow("another service");
    await expect(preparePublicDeliveryConfiguration(setup.env, "service", "wrong")).rejects.toThrow("after runtime verification");
    expect(setup.entries).toEqual(before);
    await preparePublicDeliveryConfiguration(setup.env, "service", setup.entries.get(key)!.etag);
    expect(setup.entries.get(key)!.data).toBe(PUBLICATION_SERVICE_TEXT);
    expect(setup.entries.get(key)!.customMetadata).toEqual(publicDeliveryMetadata(key, PUBLICATION_SERVICE_TEXT));
  });
});

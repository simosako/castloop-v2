import { describe, expect, test } from "bun:test";
import { parseEpisodeRevision, stringifyToml } from "../packages/shared/src/index";
import { episodeCatalogKey } from "./episode-catalog";
import type { EpisodeCatalog } from "./episode-catalog";
import { readShowControl } from "./lifecycle-control";
import { consumeOwnedPublication } from "./publication-consumer";
import { episodePublicationFixture } from "./test-support/episode-publication";
import { classifyLifecycleDeletionKey, lifecycleDeletionScopes } from "./lifecycle-deletion";
import { parsePublicAssetPath } from "./public-assets";

const effects = { async checkDeliveryGate() {}, async purge() {} };

describe("owned Episode catalog", () => {
  test("catalog is a private payload in an existing Show deletion scope, not a public asset or retained record", () => {
    const key = episodeCatalogKey("daily");
    const target = { kind: "show", showId: "daily" } as const;
    expect(parsePublicAssetPath(key.slice("public".length))).toBeNull();
    expect(classifyLifecycleDeletionKey(target, key)).toBe("payload");
    expect(lifecycleDeletionScopes(target)).toHaveLength(5);
  });

  test("36 and 200 entries use the same requests and never reread unrelated payloads or lifecycle records", async () => {
    const counts: number[] = [];
    for (const total of [36, 200]) {
      const setup = await episodePublicationFixture("metadata");
      const key = episodeCatalogKey("daily");
      const catalog: EpisodeCatalog = JSON.parse(setup.text(key));
      const template = catalog.entries.find((entry) => entry.revision.episode_id === "second")!.revision;
      while (catalog.entries.length < total) {
        const id = `extra-${catalog.entries.length}`;
        const revision = { ...template, episode_id: id, guid: crypto.randomUUID(),
          enclosure_url: template.enclosure_url.replace("/second/", `/${id}/`) };
        catalog.entries.push({ active: true, revision });
        await setup.bucket.put(`public/episodes/daily/${id}/metadata.toml`, stringifyToml(revision));
        await setup.bucket.put(`system/episode-lifecycle/daily/${id}.toml`,
          `schema_version = 1\nshow_id = "daily"\nepisode_id = "${id}"\nlifecycle = "active"\ngeneration = 0\n`);
        await setup.bucket.put(`public${new URL(revision.enclosure_url).pathname}`, "x");
      }
      await setup.bucket.put(key, JSON.stringify(catalog));
      let requests = 0;
      const inspect = (key: string) => {
        requests += 1;
        if (key.startsWith("public/episodes/daily/") && !key.startsWith("public/episodes/daily/first/") ||
          key.startsWith("system/episode-lifecycle/daily/") && key !== "system/episode-lifecycle/daily/first.toml" ||
          key.endsWith(".mp3") && !key.includes("/first/")) throw new Error("Unchanged Episode must not be reread");
      };
      const env = { CASTLOOP_BUCKET: { ...setup.bucket,
        async get(...args: Parameters<typeof setup.bucket.get>) { inspect(args[0]); return setup.bucket.get(...args); },
        async head(...args: Parameters<typeof setup.bucket.head>) { inspect(args[0]); return setup.bucket.head(...args); },
        async list() { throw new Error("Initialized catalog must not rescan inventory"); },
      } } as never;
      expect(await consumeOwnedPublication(env, setup.key, effects)).toEqual({ state: "completed" });
      counts.push(requests);
      const saved: EpisodeCatalog = JSON.parse(setup.text(key));
      expect(saved.entries).toHaveLength(total);
      expect(saved.entries.find((entry) => entry.revision.episode_id === "first")?.revision)
        .toEqual(parseEpisodeRevision(setup.text(setup.metadataKey)));
      expect((await readShowControl(setup.env, "daily"))?.value.last_feed_job_id).toBe(saved.applied_job_id!);
    }
    expect(counts[0]).toBe(counts[1]);
  });

  test("a lost catalog PUT response resumes the same pending generation without applying it twice", async () => {
    const setup = await episodePublicationFixture("metadata");
    const key = episodeCatalogKey("daily");
    const before = (await readShowControl(setup.env, "daily"))!.value.feed_generation;
    let lost = false;
    const env = { CASTLOOP_BUCKET: { ...setup.bucket,
      async put(...args: Parameters<typeof setup.bucket.put>) {
        const written = await setup.bucket.put(...args);
        if (written && args[0] === key && !lost) { lost = true; throw new Error("Catalog response lost"); }
        return written;
      },
    } } as never;
    await expect(consumeOwnedPublication(env, setup.key, effects)).rejects.toThrow("Catalog response lost");
    expect((await readShowControl(setup.env, "daily"))!.value.feed_generation).toBe(before);
    await consumeOwnedPublication(env, setup.key, effects);
    expect((await readShowControl(setup.env, "daily"))!.value.feed_generation).toBe(before + 1);
    expect(JSON.parse(setup.text(key)).feed_generation).toBe(before + 1);
    expect(setup.writes.filter((written) => written === setup.historyKey)).toHaveLength(1);
  });

  test("corrupt, foreign and unowned pending catalogs fail closed without inventory rebuild", async () => {
    for (const fault of ["missing", "corrupt", "show", "generation", "job", "hash", "duplicate", "base"] as const) {
      const setup = await episodePublicationFixture("metadata");
      const key = episodeCatalogKey("daily");
      const catalog: EpisodeCatalog = JSON.parse(setup.text(key));
      if (fault === "show") catalog.show_id = "foreign";
      if (["generation", "job", "hash"].includes(fault)) {
        catalog.feed_generation += 1;
        catalog.applied_job_id = fault === "job" ? crypto.randomUUID() : setup.operation.jobId;
        catalog.request_sha256 = fault === "hash" ? "0".repeat(64) :
          (await readShowControl(setup.env, "daily"))!.value.owner!.request_sha256;
        if (fault === "generation") catalog.feed_generation += 1;
      }
      if (fault === "duplicate") catalog.entries.push(catalog.entries[0]);
      if (fault === "base") catalog.entries.find((entry) => entry.revision.episode_id === "first")!.revision.title = "Foreign base";
      await setup.bucket.put(key, fault === "corrupt" ? "{" : JSON.stringify(catalog));
      if (fault === "missing") setup.entries.delete(key);
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async list() { throw new Error("Must not rebuild an invalid catalog"); } } } as never;
      await expect(consumeOwnedPublication(env, setup.key, effects)).rejects.toThrow();
      expect(setup.entries.has(setup.historyKey)).toBe(false);
      expect((await readShowControl(setup.env, "daily"))!.value.owner).toBeDefined();
    }
  });
});

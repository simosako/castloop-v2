import { describe, expect, test } from "bun:test";
import { frozenMigrationPlanSchema, migrationApplyProgressSchema, parseEpisodeLifecycle, parseShowControl, stringifyLifecycleToml } from "../packages/shared/src/index";
import { runLifecycleMigrationStep } from "./lifecycle-migration-apply";
import { abortUnstartedServiceMigration, acquireServiceInvocation, readServiceAdmission, resumeServiceAdmission, SERVICE_ADMISSION_KEY } from "./service-admission";
import { migrationFixture } from "./test-support/migration";

describe("owned M6 migration initialization and restart", () => {
  test("bounded initialization precedes verified cutover, stays paused and retains all payloads", async () => {
    const setup = await migrationFixture(2);
    const before = new Map(setup.entries);
    const step = () => runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects, { maximumTargets: 1 });
    expect(await step()).toEqual({ state: "pending", phase: "applying" });
    expect(parseEpisodeLifecycle(setup.entries.get("system/episode-lifecycle/daily/first.toml")!.data).lifecycle).toBe("active");
    expect(JSON.parse(setup.entries.get("system/show-publications/daily.json")!.data).state).toBe("free");
    await expect(abortUnstartedServiceMigration(setup.env, "service", setup.migrationId)).rejects.toThrow("resumed");
    expect(await step()).toEqual({ state: "pending", phase: "verifying" });
    expect(await step()).toEqual({ state: "pending", phase: "runtime" });
    expect((await readServiceAdmission(setup.env, "service"))!.value.mode).toBe("legacy");
    expect(await step()).toEqual({ state: "completed", phase: "finished" });
    const control = (await readServiceAdmission(setup.env, "service"))!.value;
    expect(control.mode).toBe("m6");
    expect(control.state).toBe("paused");
    expect(control.migration).toBeUndefined();
    expect(control.readiness?.old_cache_purged).toBe(true);
    const writes = setup.writes.length;
    expect(await step()).toEqual({ state: "completed", phase: "finished" });
    expect(setup.writes.length).toBe(writes);
    for (const [key, entry] of before) if (![SERVICE_ADMISSION_KEY, "system/show-publications/daily.json"].includes(key)) expect(setup.entries.get(key)).toEqual(entry);
    const plan = frozenMigrationPlanSchema.parse(JSON.parse(setup.entries.get(`${setup.prefix}/plan.json`)!.data));
    expect(plan.sources.some((source) => source.key === SERVICE_ADMISSION_KEY)).toBe(false);
    for (const filename of ["request", "plan", "progress"]) {
      const record = setup.entries.get(`${setup.prefix}/${filename}.json`)!.data;
      for (const privateValue of ["Private description", "Private episode", "owner@example.com", "New Show title"]) expect(record).not.toContain(privateValue);
    }
    await expect(acquireServiceInvocation(setup.env, "service", "m6_admin")).rejects.toThrow("not admitting");
    await resumeServiceAdmission(setup.env, "service", setup.pauseId);
    await expect(acquireServiceInvocation(setup.env, "service", "legacy_admin")).rejects.toThrow("not admitting");
    expect((await acquireServiceInvocation(setup.env, "service", "m6_admin")).kind).toBe("m6_admin");
  });

  test("quiescence failure writes no plan or controls and returns the known execution token", async () => {
    const setup = await migrationFixture();
    const before = setup.entries.get("system/show-publications/daily.json");
    await expect(runLifecycleMigrationStep(setup.env, "service", setup.migrationId, { ...setup.effects,
      checkQuiescence: async () => { throw new Error("Old PUT is still running"); } })).rejects.toThrow("Old PUT");
    expect(setup.entries.has(`${setup.prefix}/plan.json`)).toBe(false);
    expect(setup.entries.get("system/show-publications/daily.json")).toEqual(before);
    expect((await readServiceAdmission(setup.env, "service"))!.value.migration?.execution_id).toBeUndefined();
  });

  test("unfinished legacy owner and unknown object keys cannot initialize controls", async () => {
    for (const unknown of [false, true]) {
      const setup = await migrationFixture();
      if (unknown) await setup.bucket.put("private/unrecognized-object", "secret");
      else await setup.bucket.put("system/show-publications/daily.json", JSON.stringify({ job_id: setup.jobId, state: "processing" }));
      await expect(runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects)).rejects.toThrow();
      expect(setup.entries.has("system/episode-lifecycle/daily/first.toml")).toBe(false);
      expect(setup.entries.has(`${setup.prefix}/plan.json`)).toBe(false);
      expect((await readServiceAdmission(setup.env, "service"))!.value.migration?.execution_id).toBeUndefined();
    }
  });

  test("existing lifecycle generations, stopped state and tombstones are preserved byte-for-byte", async () => {
    const setup = await migrationFixture();
    await setup.bucket.put("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
      lifecycle: "unpublished", generation: 6, feed_generation: 4 }));
    await setup.bucket.put("system/episode-lifecycle/daily/first.toml", stringifyLifecycleToml({ schema_version: 1, show_id: "daily",
      episode_id: "first", lifecycle: "unpublished", generation: 2 }));
    await setup.bucket.put("system/episode-lifecycle/daily/deleted.toml", stringifyLifecycleToml({ schema_version: 1, show_id: "daily",
      episode_id: "deleted", lifecycle: "deleted", generation: 3 }));
    const before = new Map(setup.entries);
    for (let index = 0; index < 3; index += 1) await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects);
    for (const [key, entry] of before) if (!key.startsWith("system/lifecycle-")) expect(setup.entries.get(key)).toEqual(entry);
    expect(parseShowControl(JSON.parse(setup.entries.get("system/show-publications/daily.json")!.data)).generation).toBe(6);
  });

  test("initialized controls plus a lost progress response resume without rewriting immutable controls", async () => {
    for (const keyKind of ["plan", "episode", "show", "progress"] as const) {
      const setup = await migrationFixture();
      const key = keyKind === "episode" ? "system/episode-lifecycle/daily/first.toml" : keyKind === "show" ?
        "system/show-publications/daily.json" : `${setup.prefix}/${keyKind}.json`;
      let lost = false;
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
        const result = await setup.bucket.put(...args);
        if (!lost && result && args[0] === key) { lost = true; throw new Error("Migration PUT response lost"); }
        return result;
      } } } as never;
      await expect(runLifecycleMigrationStep(env, "service", setup.migrationId, setup.effects)).rejects.toThrow("response lost");
      const persisted = setup.entries.get(key);
      expect(persisted).toBeDefined();
      expect((await readServiceAdmission(setup.env, "service"))!.value.migration?.execution_id).toBeUndefined();
      for (let index = 0; index < 4; index += 1) await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects);
      if (keyKind === "episode" || keyKind === "show" || keyKind === "plan") expect(setup.entries.get(key)).toEqual(persisted);
      expect((await readServiceAdmission(setup.env, "service"))!.value.mode).toBe("m6");
    }
  });

  test("runtime failures retain fixed diagnostics, never open M6 and can retry cutover", async () => {
    const setup = await migrationFixture();
    const step = () => runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects);
    await step(); await step();
    await expect(runLifecycleMigrationStep(setup.env, "service", setup.migrationId, { ...setup.effects,
      verifyCutover: async () => { throw new Error("Private title: secret runtime failure"); } })).rejects.toThrow("runtime failure");
    const progress = migrationApplyProgressSchema.parse(JSON.parse(setup.entries.get(`${setup.prefix}/progress.json`)!.data));
    expect(progress.reason_code).toBe("migration_runtime_failed");
    expect(JSON.stringify(progress)).not.toContain("Private title");
    expect((await readServiceAdmission(setup.env, "service"))!.value.mode).toBe("legacy");
    expect(await step()).toEqual({ state: "completed", phase: "finished" });
  });

  test("changed, removed and new sources after plan freezing fail closed on restart", async () => {
    for (const change of ["changed", "removed", "new", "control"] as const) {
      const setup = await migrationFixture();
      await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects, { maximumTargets: 1 });
      if (change === "changed") await setup.bucket.put("public/podcasts/daily/feed.xml", "changed");
      if (change === "removed") setup.entries.delete("public/podcasts/daily/cover.jpg");
      if (change === "new") await setup.bucket.put("private/unknown", "new");
      if (change === "control") await setup.bucket.put("system/episode-lifecycle/daily/first.toml", stringifyLifecycleToml({ schema_version: 1,
        show_id: "daily", episode_id: "first", lifecycle: "active", generation: 9 }));
      await expect(runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects)).rejects.toThrow("Migration");
      expect((await readServiceAdmission(setup.env, "service"))!.value.mode).toBe("legacy");
      expect((await readServiceAdmission(setup.env, "service"))!.value.migration?.execution_id).toBeUndefined();
    }
  });

  test("corrupt progress returns a normally completed invocation token but remains blocked", async () => {
    const setup = await migrationFixture();
    await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects);
    await setup.bucket.put(`${setup.prefix}/progress.json`, "{}");
    await expect(runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects)).rejects.toThrow();
    expect((await readServiceAdmission(setup.env, "service"))!.value.migration?.execution_id).toBeUndefined();
    expect((await readServiceAdmission(setup.env, "service"))!.value.state).toBe("migrating");
  });

  test("completion response loss is idempotent and finished evidence survives a pre-write failure", async () => {
    for (const persisted of [false, true]) {
      const setup = await migrationFixture();
      await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects);
      await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects);
      let failed = false;
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
        if (!failed && args[0] === SERVICE_ADMISSION_KEY && args[1].includes('"mode":"m6"')) {
          failed = true;
          if (persisted) await setup.bucket.put(...args);
          throw new Error("Completion response lost");
        }
        return setup.bucket.put(...args);
      } } } as never;
      if (persisted) expect(await runLifecycleMigrationStep(env, "service", setup.migrationId, setup.effects)).toEqual({ state: "completed", phase: "finished" });
      else await expect(runLifecycleMigrationStep(env, "service", setup.migrationId, setup.effects)).rejects.toThrow("response lost");
      let calls = 0;
      expect(await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, { ...setup.effects,
        verifyCutover: async () => { calls += 1; return setup.runtime; } })).toEqual({ state: "completed", phase: "finished" });
      expect(calls).toBe(persisted ? 0 : 1);
    }
  });

  test("only one awaited migration invocation may run and completion does not depend on elapsed time", async () => {
    const setup = await migrationFixture();
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const outcome = runLifecycleMigrationStep(setup.env, "service", setup.migrationId, { ...setup.effects,
      checkQuiescence: async () => { started.resolve(); await finished.promise; } });
    await started.promise;
    await expect(runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects)).rejects.toThrow("still running");
    expect(setup.entries.has(`${setup.prefix}/plan.json`)).toBe(false);
    finished.resolve();
    await outcome;
    expect((await readServiceAdmission(setup.env, "service"))!.value.migration?.execution_id).toBeUndefined();
  });

  test("invalid runtime proof and source changes during cutover cannot produce readiness", async () => {
    for (const changeSource of [false, true]) {
      const setup = await migrationFixture();
      await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects);
      await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects);
      await expect(runLifecycleMigrationStep(setup.env, "service", setup.migrationId, { ...setup.effects,
        verifyCutover: async () => {
          if (changeSource) await setup.bucket.put("public/podcasts/daily/feed.xml", "late old consumer write");
          return changeSource ? setup.runtime : { ...setup.runtime, default_cache_disabled: false } as never;
        } })).rejects.toThrow();
      expect((await readServiceAdmission(setup.env, "service"))!.value.mode).toBe("legacy");
      expect((await readServiceAdmission(setup.env, "service"))!.value.readiness).toBeUndefined();
    }
  });

  test("finished progress cannot bless a different deployment on completion retry", async () => {
    const setup = await migrationFixture();
    await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects);
    await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects);
    let lost = false;
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
      const result = await setup.bucket.put(...args);
      if (!lost && args[0] === `${setup.prefix}/progress.json` && args[1].includes('"phase":"finished"')) {
        lost = true; throw new Error("Finished progress response lost");
      }
      return result;
    } } } as never;
    await expect(runLifecycleMigrationStep(env, "service", setup.migrationId, setup.effects)).rejects.toThrow("response lost");
    await expect(runLifecycleMigrationStep(setup.env, "service", setup.migrationId, { ...setup.effects,
      verifyCutover: async () => ({ ...setup.runtime, worker_version_id: crypto.randomUUID() }) })).rejects.toThrow("runtime changed");
    expect((await readServiceAdmission(setup.env, "service"))!.value.mode).toBe("legacy");
    expect((await readServiceAdmission(setup.env, "service"))!.value.migration?.execution_id).toBeUndefined();
    expect(await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects)).toEqual({ state: "completed", phase: "finished" });
  });

  test("frozen plan schema refuses duplicate targets, private fields and nonminimal initialization", async () => {
    const setup = await migrationFixture();
    await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects);
    const plan = JSON.parse(setup.entries.get(`${setup.prefix}/plan.json`)!.data);
    for (const changes of [{ title: "Private title" }, { sources: [...plan.sources, plan.sources[0]] },
      { shows: [...plan.shows, plan.shows[0]] }, { shows: [{ ...plan.shows[0], value: { ...plan.shows[0].value, generation: 1 } }] },
      { sources: [...plan.sources, { key: "secret/path", etag: "1", size: 1 }] }]) {
      expect(frozenMigrationPlanSchema.safeParse({ ...plan, ...changes }).success).toBe(false);
    }
  });

  test("published service identity must match the migration owner before plan freezing", async () => {
    const setup = await migrationFixture();
    const service = setup.entries.get("system/service.toml")!.data;
    await setup.bucket.put("system/service.toml", service.replace("service_id = 'service'", "service_id = 'different'"));
    await expect(runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects)).rejects.toThrow("service configuration");
    expect(setup.entries.has(`${setup.prefix}/plan.json`)).toBe(false);
    expect(setup.entries.has("system/episode-lifecycle/daily/first.toml")).toBe(false);
  });
});

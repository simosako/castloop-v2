import { describe, expect, test } from "bun:test";
import { showRegistrationRequestSchema, showRegistrationResponseSchema } from "../packages/shared/src/index";
import { claimShowOperation, readShowControl } from "./lifecycle-control";
import { inspectShowRegistration, reserveM6Show } from "./show-registration";
import { readShowReservation } from "./show-reservation-record";
import { lifecycleFixture } from "./test-support/lifecycle";

async function fixture() {
  const setup = await lifecycleFixture();
  setup.writes.length = 0;
  const request = showRegistrationRequestSchema.parse({ schema_version: 1, service_id: "service", show_id: "new-show",
    reservation_id: crypto.randomUUID(), action: "reserve" });
  const controlKey = "system/show-publications/new-show.json";
  const reservationKey = "system/show-reservations/new-show.json";
  const stage = () => ({ schema_version: 1 as const, job_id: crypto.randomUUID(), show_id: "new-show", kind: "show" as const, action: "stage" as const,
    expected_show_generation: 0, created_at: "2026-10-02T12:00:00Z" });
  const status = () => inspectShowRegistration(setup.env, { ...request, action: "status" });
  return { ...setup, request, controlKey, reservationKey, stage, status };
}

describe("atomic M6 Show registration identity and draft initialization", () => {
  test("claims identity on Show control before reservation, leaves a private minimal draft and permits staging only when complete", async () => {
    const setup = await fixture();
    expect(await setup.status()).toMatchObject({ state: "missing", lifecycle: null, generation: null, authorizes_registration: false });
    const result = await reserveM6Show(setup.env, setup.request);
    expect(result).toEqual({ schema_version: 1, service_id: "service", show_id: "new-show", reservation_id: setup.request.reservation_id,
      result: "reserved", control_ready: true });
    expect(setup.writes).toEqual([setup.controlKey, setup.reservationKey]);
    expect((await readShowControl(setup.env, "new-show"))!.value).toEqual({ schema_version: 2, show_id: "new-show",
      reservation_id: setup.request.reservation_id, lifecycle: "draft", generation: 0, feed_generation: 0 });
    expect((await readShowReservation(setup.env, "new-show"))!.value).toEqual({ show_id: "new-show", reservation_id: setup.request.reservation_id });
    expect(await setup.status()).toMatchObject({ state: "reserved", lifecycle: "draft", authorizes_registration: false });
    expect((await claimShowOperation(setup.env, setup.stage())).value.owner?.action).toBe("stage");
  });

  test("same reservation is idempotent after completion or later Show progress without resetting its lifecycle or owner", async () => {
    const setup = await fixture();
    const receipt = await reserveM6Show(setup.env, setup.request);
    const stage = await claimShowOperation(setup.env, setup.stage());
    const before = [...setup.entries];
    expect(await reserveM6Show(setup.env, setup.request)).toEqual(receipt);
    expect([...setup.entries]).toEqual(before);
    expect((await readShowControl(setup.env, "new-show"))!.value).toEqual(stage.value);
  });

  test("concurrent different reservation IDs have one winner; losing identity cannot adopt or overwrite the Show", async () => {
    const setup = await fixture();
    const other = { ...setup.request, reservation_id: crypto.randomUUID() };
    const results = await Promise.allSettled([reserveM6Show(setup.env, setup.request), reserveM6Show(setup.env, other)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const control = (await readShowControl(setup.env, "new-show"))!.value;
    expect((await readShowReservation(setup.env, "new-show"))!.value.reservation_id).toBe(control.reservation_id!);
    expect(setup.writes.filter((key) => key === setup.controlKey)).toHaveLength(1);
    expect(setup.writes.filter((key) => key === setup.reservationKey)).toHaveLength(1);
    const loser = control.reservation_id === setup.request.reservation_id ? other : setup.request;
    await expect(reserveM6Show(setup.env, loser)).rejects.toThrow();
    expect(await inspectShowRegistration(setup.env, { ...loser, action: "status" })).toMatchObject({ state: "occupied", authorizes_registration: false });
  });

  test("concurrent same-identity registration creates each record only once", async () => {
    const setup = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => reserveM6Show(setup.env, setup.request)));
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(setup.writes).toEqual([setup.controlKey, setup.reservationKey]);
  });

  test("failed or lost control/reservation PUT responses never permit staging during partial registration; exact explicit reserve can reconcile", async () => {
    for (const target of ["control", "reservation"] as const) for (const afterWrite of [false, true]) {
      const setup = await fixture();
      const key = target === "control" ? setup.controlKey : setup.reservationKey;
      let lose = true;
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
        if (args[0] === key && lose) {
          lose = false;
          if (afterWrite) await setup.bucket.put(...args);
          throw new Error("Response lost after all IO ended");
        }
        return setup.bucket.put(...args);
      } } } as never;
      await expect(reserveM6Show(env, setup.request)).rejects.toThrow("Response lost");
      const status = await setup.status();
      expect(status.result).toBe("status");
      if (status.result !== "status") throw new Error("Expected status");
      expect(status.authorizes_registration).toBe(false);
      if (status.state !== "reserved") await expect(claimShowOperation(setup.env, setup.stage())).rejects.toThrow();
      const before = setup.entries.get(setup.controlKey);
      await reserveM6Show(env, setup.request);
      if (before) expect(setup.entries.get(setup.controlKey)).toEqual(before);
      expect(await setup.status()).toMatchObject({ state: "reserved" });
    }
  });

  test("existing reservation without control and legacy controls are never adopted or recreated", async () => {
    const setup = await fixture();
    await setup.bucket.put(setup.reservationKey, JSON.stringify({ show_id: "new-show", reservation_id: setup.request.reservation_id }));
    setup.writes.length = 0;
    await expect(reserveM6Show(setup.env, setup.request)).rejects.toThrow("requires recovery");
    expect(setup.writes).toHaveLength(0);
    const legacy = await fixture();
    await legacy.bucket.put(legacy.controlKey, JSON.stringify({ job_id: crypto.randomUUID(), state: "free" }));
    legacy.writes.length = 0;
    await expect(reserveM6Show(legacy.env, legacy.request)).rejects.toThrow();
    expect(legacy.writes).toHaveLength(0);
  });

  test("all existing or deleted controls block a new reservation identity, even with no reservation record", async () => {
    for (const lifecycle of ["draft", "active", "unpublished", "deleting", "deleted"] as const) {
      const setup = await fixture();
      await setup.bucket.put(setup.controlKey, JSON.stringify({ schema_version: 2, show_id: "new-show", lifecycle, generation: 9, feed_generation: 3 }));
      const before = [...setup.entries];
      await expect(reserveM6Show(setup.env, setup.request)).rejects.toThrow("cannot be registered");
      expect([...setup.entries]).toEqual(before);
    }
  });

  test("deleted Show cannot be registered again even using its original reservation ID", async () => {
    const setup = await fixture();
    await reserveM6Show(setup.env, setup.request);
    await setup.bucket.put(setup.controlKey, JSON.stringify({ ...(await readShowControl(setup.env, "new-show"))!.value,
      lifecycle: "deleted", generation: 7 }));
    const before = [...setup.entries];
    await expect(reserveM6Show(setup.env, setup.request)).rejects.toThrow("cannot be registered");
    expect([...setup.entries]).toEqual(before);
  });

  test("advanced control with a missing reservation is not repaired as a new registration", async () => {
    const setup = await fixture();
    await reserveM6Show(setup.env, setup.request);
    await claimShowOperation(setup.env, setup.stage());
    setup.entries.delete(setup.reservationKey);
    const before = [...setup.entries];
    await expect(reserveM6Show(setup.env, setup.request)).rejects.toThrow("advanced Show requires recovery");
    expect([...setup.entries]).toEqual(before);
  });

  test("orphan data in every scope and incomplete list results refuse registration before writing anything", async () => {
    for (const key of ["system/shows/new-show/show.toml", "system/episode-lifecycle/new-show/episode.toml", "public/podcasts/new-show/unknown",
      "public/episodes/new-show/episode/metadata.toml", "staging/shows/new-show/job/cover.jpg", "staging/episodes/new-show/episode/job/audio.mp3"]) {
      const setup = await fixture();
      await setup.bucket.put(key, "preserve");
      setup.writes.length = 0;
      await expect(reserveM6Show(setup.env, setup.request)).rejects.toThrow("existing data");
      expect(setup.writes).toHaveLength(0);
    }
    const setup = await fixture();
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, list: async () => ({ objects: [], truncated: true }) } } as never;
    await expect(reserveM6Show(env, setup.request)).rejects.toThrow("existing data");
    expect(setup.writes).toHaveLength(0);
  });

  test("registration status reads only and rejects record drift and arbitrary malformed reservation bodies", async () => {
    const setup = await fixture();
    await reserveM6Show(setup.env, setup.request);
    const before = [...setup.entries];
    await setup.status();
    expect([...setup.entries]).toEqual(before);
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async head(key: string) {
      const value = await setup.bucket.head(key);
      return value && key === setup.reservationKey ? { ...value, etag: "changed" } : value;
    } } } as never;
    await expect(inspectShowRegistration(env, { ...setup.request, action: "status" })).rejects.toThrow("changed");
    await setup.bucket.put(setup.reservationKey, JSON.stringify({ show_id: "new-show", reservation_id: setup.request.reservation_id,
      title: "private title" }));
    await expect(setup.status()).rejects.toThrow();
  });

  test("wire schemas reject unknown fields, invalid IDs and status that could authorize or misrepresent initialization", () => {
    const identity = { schema_version: 1, service_id: "service", show_id: "new-show", reservation_id: crypto.randomUUID() };
    for (const input of [{ ...identity, action: "reserve", title: "private" }, { ...identity, action: "reserve", show_id: "../other" },
      { ...identity, action: "reserve", reservation_id: "bad" }]) expect(showRegistrationRequestSchema.safeParse(input).success).toBe(false);
    const status = { ...identity, result: "status", state: "initializing", lifecycle: "draft", generation: 0, authorizes_registration: false };
    expect(showRegistrationResponseSchema.safeParse(status).success).toBe(true);
    for (const changed of [{ authorizes_registration: true }, { generation: 1 }, { lifecycle: "active" }, { state: "reserved", lifecycle: null, generation: null }]) {
      expect(showRegistrationResponseSchema.safeParse({ ...status, ...changed }).success).toBe(false);
    }
  });

  test("orphan data appearing after identity CAS leaves an initializing record, never a ready reservation", async () => {
    const setup = await fixture();
    let lists = 0;
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async list(...args: Parameters<typeof setup.bucket.list>) {
      if (++lists === 7) await setup.bucket.put("system/shows/new-show/show.toml", "late orphan");
      return setup.bucket.list(...args);
    } } } as never;
    await expect(reserveM6Show(env, setup.request)).rejects.toThrow("existing data");
    expect(setup.entries.has(setup.controlKey)).toBe(true);
    expect(setup.entries.has(setup.reservationKey)).toBe(false);
    expect(await setup.status()).toMatchObject({ state: "initializing", authorizes_registration: false });
    await expect(claimShowOperation(setup.env, setup.stage())).rejects.toThrow("incomplete");
    await expect(reserveM6Show(setup.env, setup.request)).rejects.toThrow("existing data");
    expect(setup.entries.get("system/shows/new-show/show.toml")?.data).toBe("late orphan");
  });

  test("late foreign reservation is not overwritten and incomplete identity never admits mutations", async () => {
    const setup = await fixture();
    const foreignId = crypto.randomUUID();
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
      if (args[0] === setup.reservationKey) await setup.bucket.put(setup.reservationKey, JSON.stringify({ show_id: "new-show", reservation_id: foreignId }));
      return setup.bucket.put(...args);
    } } } as never;
    await expect(reserveM6Show(env, setup.request)).rejects.toThrow("matching control and reservation");
    expect((await readShowReservation(setup.env, "new-show"))!.value.reservation_id).toBe(foreignId);
    expect((await readShowControl(setup.env, "new-show"))!.value.reservation_id).toBe(setup.request.reservation_id);
    await expect(claimShowOperation(setup.env, setup.stage())).rejects.toThrow("another registration");
  });
});

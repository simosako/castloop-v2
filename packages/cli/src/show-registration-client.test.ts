import { describe, expect, test } from "bun:test";
import { showRegistrationRequestSchema } from "@castloop/shared";
import { ShowRegistrationClient } from "./show-registration-client";
import type { M6AdminTransport } from "./m6-admin-json";
import { claimShowOperation, readShowControl } from "../../../src/lifecycle-control";
import { fetchM6Candidate, fetchM6ManagementIntegration } from "../../../src/m6-routes";
import type { M6CachedLoopback, M6CandidateEnv } from "../../../src/m6-routes";
import { pauseServiceAdmission, readServiceAdmission, SERVICE_ADMISSION_KEY } from "../../../src/service-admission";
import { reserveM6Show } from "../../../src/show-registration";
import { readShowReservation } from "../../../src/show-reservation-record";
import { lifecycleAdminFixture } from "../../../src/test-support/lifecycle-admin";
import { stagingAdminFixture } from "../../../src/test-support/staging-admin";

async function fixture() {
  const setup = await stagingAdminFixture("show");
  const request = showRegistrationRequestSchema.parse({ schema_version: 1, service_id: "service", show_id: "new-show",
    reservation_id: crypto.randomUUID(), action: "reserve" });
  const status = { ...request, action: "status" as const };
  const env: M6CandidateEnv = { CASTLOOP_BUCKET: setup.bucket as never, CASTLOOP_ADMIN_KEY: "private-secret",
    CASTLOOP_DLQ_NAME: setup.config.dlq_name, CASTLOOP_VERSION_METADATA: { id: setup.versionId, tag: "", timestamp: "2026-10-02T12:00:00Z" },
    CASTLOOP_QUEUE: { send: async () => { throw new Error("Registration must not send Queue messages"); } } as never };
  const cachedAssets: M6CachedLoopback = Object.assign(() => ({ fetch: async () => new Response() }), {
    invalidate: async () => { throw new Error("Registration must not purge public assets"); }, ...setup.bindings.cachedAssets,
  });
  const calls: Request[] = [];
  const transport: M6AdminTransport = async (input, init) => {
    const http = new Request<unknown, IncomingRequestCfProperties>(input, { method: init.method, headers: init.headers, body: init.body,
      signal: init.signal, redirect: init.redirect, cache: init.cache });
    calls.push(http.clone());
    expect(new URL(http.url).origin).toBe(setup.config.workers_dev_base_url!);
    expect(new URL(http.url).pathname).toBe("/admin/shows");
    expect(http.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(http.headers.get("X-Castloop-Key")).toBe("private-secret");
    expect(http.headers.get("Authorization")).toBeNull();
    return fetchM6ManagementIntegration(http, env, cachedAssets);
  };
  const client = new ShowRegistrationClient(setup.config, "private-secret", transport);
  return { ...setup, request, status, env, cachedAssets, calls, transport, client };
}

describe("unreleased Show registration client and M6 fetch integration", () => {
  test("status is read-only, reserve initializes a private Show and follows exact identity without resetting it", async () => {
    const setup = await fixture();
    const before = [...setup.entries];
    expect(await setup.client.status(setup.status)).toMatchObject({ state: "missing", authorizes_registration: false });
    expect([...setup.entries]).toEqual(before);
    expect(await setup.client.reserve(setup.request)).toMatchObject({ result: "reserved", control_ready: true,
      reservation_id: setup.request.reservation_id });
    const initialized = [...setup.entries];
    expect(await setup.client.status(setup.status)).toMatchObject({ state: "reserved", lifecycle: "draft", generation: 0 });
    expect([...setup.entries]).toEqual(initialized);
    expect((await readShowControl(setup.env, "new-show"))!.value.reservation_id).toBe(setup.request.reservation_id);
    await claimShowOperation(setup.env, { schema_version: 1, show_id: "new-show", job_id: crypto.randomUUID(), kind: "show", action: "stage",
      expected_show_generation: 0, created_at: "2026-10-02T12:00:00Z" });
    const owned = [...setup.entries];
    await setup.client.reserve(setup.request);
    expect([...setup.entries].filter(([key]) => key !== SERVICE_ADMISSION_KEY)).toEqual(owned.filter(([key]) => key !== SERVICE_ADMISSION_KEY));
    expect((await setup.client.status(setup.status)).generation).toBe(1);
  });

  test("default candidate rejects registration even with mock readiness and keeps all records unchanged", async () => {
    const setup = await fixture();
    const before = [...setup.entries];
    const http = new Request<unknown, IncomingRequestCfProperties>("https://current.example/admin/shows", {
      method: "POST", headers: { "X-Castloop-Key": "private-secret" }, body: JSON.stringify(setup.request),
    });
    expect((await fetchM6Candidate(http, setup.env, setup.cachedAssets)).status).toBe(409);
    expect([...setup.entries]).toEqual(before);
  });

  test("integration refuses uninitialized/legacy/migrating/wrong-version runtime without creating records", async () => {
    for (const failure of ["missing", "legacy", "migrating", "version"] as const) {
      const setup = await fixture();
      if (failure === "missing") setup.entries.delete(SERVICE_ADMISSION_KEY);
      if (failure === "legacy") await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ schema_version: 1, service_id: "service",
        mode: "legacy", state: "open", generation: 0, invocations: [] }));
      if (failure === "migrating") await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ ...setup.service, state: "migrating",
        pause_id: crypto.randomUUID(), migration: { migration_id: crypto.randomUUID(), request_sha256: "a".repeat(64) } }));
      if (failure === "version") setup.env.CASTLOOP_VERSION_METADATA.id = crypto.randomUUID();
      const before = [...setup.entries];
      await expect(setup.client.reserve(setup.request)).rejects.toThrow("not verified");
      expect([...setup.entries]).toEqual(before);
      expect(setup.calls).toHaveLength(1);
    }
  });

  test("paused service blocks reserve but permits read-only status; foreign service/input/auth/method are rejected", async () => {
    const setup = await fixture();
    await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ ...setup.service, state: "paused", pause_id: crypto.randomUUID() }));
    const before = [...setup.entries];
    await expect(setup.client.reserve(setup.request)).rejects.toThrow("not verified");
    expect(await setup.client.status(setup.status)).toMatchObject({ state: "missing", authorizes_registration: false });
    expect([...setup.entries]).toEqual(before);
    const call = (input: unknown, key = "private-secret", method = "POST") => fetchM6ManagementIntegration(
      new Request<unknown, IncomingRequestCfProperties>("https://current.example/admin/shows", { method, headers: { "X-Castloop-Key": key },
        ...(method === "POST" ? { body: JSON.stringify(input) } : {}) }), setup.env, setup.cachedAssets);
    expect((await call({ ...setup.request, service_id: "other" })).status).toBe(400);
    expect((await call({ ...setup.request, secret: "private" })).status).toBe(400);
    expect((await call(setup.request, "wrong")).status).toBe(401);
    expect((await call(setup.request, "private-secret", "GET")).status).toBe(405);
    expect([...setup.entries]).toEqual(before);
  });

  test("lost reserve response is not retried or treated as success; later status only observes the retained reservation", async () => {
    const setup = await fixture();
    let lost = true;
    const transport: M6AdminTransport = async (input, init) => {
      const response = await setup.transport(input, init);
      if (lost) { lost = false; throw new Error("private transport diagnostic"); }
      return response;
    };
    const client = new ShowRegistrationClient(setup.config, "private-secret", transport);
    await expect(client.reserve(setup.request)).rejects.toThrow("outcome is unknown");
    expect(setup.calls).toHaveLength(1);
    const before = [...setup.entries];
    expect(await client.status(setup.status)).toMatchObject({ state: "reserved", authorizes_registration: false });
    expect([...setup.entries]).toEqual(before);
    expect(setup.calls).toHaveLength(2);
  });

  test("wrong service/action/invalid request fail before HTTP, and forged successful receipts are not accepted", async () => {
    const setup = await fixture();
    for (const request of [{ ...setup.request, service_id: "other" }, { ...setup.request, action: "status" as const },
      { ...setup.request, reservation_id: "bad" }]) await expect(setup.client.reserve(request)).rejects.toThrow();
    expect(setup.calls).toHaveLength(0);
    for (const change of [{ service_id: "other" }, { show_id: "other" }, { reservation_id: crypto.randomUUID() },
      { control_ready: false }, { title: "private" }, { result: "status" }]) {
      const client = new ShowRegistrationClient(setup.config, "private-secret", async () => Response.json({ schema_version: 1,
        service_id: "service", show_id: "new-show", reservation_id: setup.request.reservation_id, result: "reserved", control_ready: true, ...change },
        { headers: { "Cache-Control": "no-store" } }));
      await expect(client.reserve(setup.request)).rejects.toThrow("not verified");
    }
  });

  test("registration holds its service invocation until R2 IO finishes; pause rejects new mutations without stealing the running token", async () => {
    const setup = await fixture();
    let continuePut!: () => void;
    let started!: () => void;
    const pendingPut = new Promise<void>((resolve) => { continuePut = resolve; });
    const putStarted = new Promise<void>((resolve) => { started = resolve; });
    setup.env.CASTLOOP_BUCKET = { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
      if (args[0] === "system/show-reservations/new-show.json") { started(); await pendingPut; }
      return setup.bucket.put(...args);
    } } as never;
    const pending = setup.client.reserve(setup.request);
    try {
      await putStarted;
      const admission = (await readServiceAdmission(setup.env, "service"))!.value;
      expect(admission.invocations).toHaveLength(1);
      expect(admission.invocations[0]!.kind).toBe("m6_admin");
      await expect(claimShowOperation(setup.env, { schema_version: 1, show_id: "new-show", job_id: crypto.randomUUID(), kind: "show", action: "stage",
        expected_show_generation: 0, created_at: "2026-10-02T12:00:00Z" })).rejects.toThrow("incomplete");
      await pauseServiceAdmission(setup.env, "service", crypto.randomUUID());
      await expect(setup.client.reserve({ ...setup.request, show_id: "another-show", reservation_id: crypto.randomUUID() })).rejects.toThrow("not verified");
      expect((await readServiceAdmission(setup.env, "service"))!.value.invocations).toEqual(admission.invocations);
    } finally { continuePut(); await pending; }
    expect(await pending).toMatchObject({ result: "reserved" });
    expect((await readServiceAdmission(setup.env, "service"))!.value).toMatchObject({ state: "paused", invocations: [] });
  });

  test("registration identity survives publication, unpublish, restoration and deletion; deleted IDs cannot be re-registered", async () => {
    const setup = await lifecycleAdminFixture();
    const identity = (await readShowControl(setup.env, "daily"))!.value.reservation_id!;
    expect(identity).toBeString();
    expect((await readShowReservation(setup.env, "daily"))!.value.reservation_id).toBe(identity);
    for (const action of ["unpublish", "restore", "delete"] as const) {
      await setup.execute(await setup.operationRequest("show", action));
      expect((await readShowControl(setup.env, "daily"))!.value.reservation_id).toBe(identity);
      expect((await readShowReservation(setup.env, "daily"))!.value.reservation_id).toBe(identity);
    }
    expect((await readShowControl(setup.env, "daily"))!.value.lifecycle).toBe("deleted");
    const before = [...setup.entries];
    await expect(reserveM6Show(setup.env, { schema_version: 1, service_id: "service", show_id: "daily", reservation_id: identity,
      action: "reserve" })).rejects.toThrow("cannot be registered again");
    expect([...setup.entries]).toEqual(before);
  });
});

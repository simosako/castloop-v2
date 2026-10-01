import { expect, test } from "bun:test";
import { lifecycleAdminRequestSchema } from "@castloop/shared";
import type { LifecycleAdminRequest, LifecycleOperationRequest } from "@castloop/shared";
import { handleM6LifecycleAdmin } from "../../../src/lifecycle-admin";
import { readPublicVisibility, readShowControl } from "../../../src/lifecycle-control";
import { lifecycleAdminFixture } from "../../../src/test-support/lifecycle-admin";
import { LifecycleAdminClient } from "./lifecycle-client";
import type { LifecycleAdminTransport } from "./lifecycle-client";

type Setup = Awaited<ReturnType<typeof lifecycleAdminFixture>>;
type Action = LifecycleAdminRequest["action"];
type Input<A extends Action> = Extract<LifecycleAdminRequest, { action: A }>;

async function body<A extends Action>(setup: Setup, action: A, request: LifecycleOperationRequest): Promise<Input<A>> {
  return lifecycleAdminRequestSchema.parse(await setup.body(action, request)) as Input<A>;
}

function transport(setup: Setup, calls: Request[]): LifecycleAdminTransport {
  return (async (input, init) => {
    const request = new Request(input, init);
    calls.push(request.clone());
    const response = await handleM6LifecycleAdmin(request, setup.env, setup.bindings);
    if (!response) throw new Error("Unrecognized internal lifecycle route");
    return response;
  });
}

function json(input: unknown, headers: HeadersInit = {}): Response {
  return Response.json(input, { headers: { "Cache-Control": "no-store", ...headers } });
}

for (const kind of ["show", "episode"] as const) {
  test(`internal lifecycle client connects ${kind} stop/restore/delete without exposing CLI commands`, async () => {
    const setup = await lifecycleAdminFixture();
    const calls: Request[] = [];
    const client = new LifecycleAdminClient(setup.config, "private-secret", transport(setup, calls));
    for (const action of ["unpublish", "restore", "delete"] as const) {
      const request = await setup.operationRequest(kind, action);
      const before = setup.text("system/show-publications/daily.json");
      const preview = await client.dryRun(await body(setup, "dry-run", request));
      expect(preview.eligible).toBe(true);
      expect(preview.authorizes_operation).toBe(false);
      expect(preview.payloads_verified).toBe(false);
      expect(setup.text("system/show-publications/daily.json")).toBe(before);
      const claim = await client.claim(await body(setup, "claim", request));
      expect(claim.operation.show_generation).toBe(request.expected_show_generation + 1);
      const reserved = await client.status(await body(setup, "status", request));
      expect(reserved.ownership).toBe("held");
      expect(reserved.marker_present).toBe(false);
      const commit = await client.commit(await body(setup, "commit", request));
      expect(commit.created).toBe(true);
      expect((await client.commit(await body(setup, "commit", request))).created).toBe(false);
      await setup.consume(commit.key);
      const finished = await client.status(await body(setup, "status", request));
      expect(finished.status?.state).toBe("completed");
      expect(finished.authorizes_retry).toBe(false);
      expect(await readPublicVisibility(setup.env, "daily", kind === "episode" ? "next" : undefined))
        .toBe(action === "unpublish" ? "not_found" : action === "restore" ? "public" : "gone");
    }
    for (const request of calls) {
      expect(request.url).toBe(new URL("/admin/lifecycle", setup.config.public_base_url).href);
      expect(request.method).toBe("POST");
      expect(request.redirect).toBe("error");
      expect(request.headers.get("X-Castloop-Key")).toBe("private-secret");
      expect(request.cache).toBe("no-store");
      expect(await request.text()).not.toContain("private-secret");
    }
  });
}

test("client requeues only an explicit confirmed same-job request and does not claim completion", async () => {
  const setup = await lifecycleAdminFixture();
  const calls: Request[] = [];
  const client = new LifecycleAdminClient(setup.config, "private-secret", transport(setup, calls));
  const request = await setup.operationRequest("episode", "unpublish");
  await client.claim(await body(setup, "claim", request));
  const commit = await client.commit(await body(setup, "commit", request));
  const owner = (await readShowControl(setup.env, "daily"))!.value.owner;
  const marker = await setup.bucket.head(commit.key);
  const result = await client.retry(await body(setup, "retry", request));
  expect(result.result).toBe("requeued");
  expect("created" in result).toBe(false);
  expect(setup.continuations).toEqual([commit.key]);
  expect((await setup.bucket.head(commit.key))!.etag).toBe(marker!.etag);
  expect((await readShowControl(setup.env, "daily"))!.value.owner).toEqual(owner);
  expect(calls.map((request) => request.method)).toEqual(["POST", "POST", "POST"]);
});

test("client validates origin, credentials, action, service and full confirmation before sending", async () => {
  const setup = await lifecycleAdminFixture();
  let calls = 0;
  const fetcher: LifecycleAdminTransport = async () => { calls += 1; throw new Error("Transport must not run"); };
  for (const public_base_url of ["http://current.example", "https://user:secret@current.example", "https://current.example/path",
    "https://current.example?query", "https://current.example/#fragment"]) {
    expect(() => new LifecycleAdminClient({ ...setup.config, public_base_url }, "private-secret", fetcher)).toThrow();
  }
  for (const key of ["", "secret\nheader", "secret\u0000header"]) {
    expect(() => new LifecycleAdminClient(setup.config, key, fetcher)).toThrow();
  }
  const client = new LifecycleAdminClient(setup.config, "private-secret", fetcher);
  const input = await body(setup, "claim", await setup.operationRequest("episode", "delete"));
  const invalid = [
    { ...input, service_id: "foreign" },
    { ...input, confirmation: { ...input.confirmation, request_sha256: "0".repeat(64) } },
    { ...input, request: { ...input.request, expected_episode_generation: input.request.expected_episode_generation! + 1 } },
    { ...input, confirmation: { operator_confirmed: true, request_sha256: input.confirmation.request_sha256 } },
    { ...input, request: { ...input.request, title: "private metadata" } },
    { ...input, request: { ...input.request, expected_show_generation: Number.MAX_SAFE_INTEGER } },
  ];
  for (const request of invalid) await expect(client.claim(request as never)).rejects.toThrow();
  await expect(client.commit(input as never)).rejects.toThrow("action differs");
  expect(calls).toBe(0);
});

test("client rejects foreign/altered preview and page evidence", async () => {
  const setup = await lifecycleAdminFixture();
  const request = await setup.operationRequest("episode", "delete");
  const input = { ...await body(setup, "dry-run", request), maximum_objects: 1 };
  const original = await setup.success(input);
  if (original.result !== "preview") throw new Error("Expected preview");
  const variants = [
    { ...original, service_id: "foreign" },
    { ...original, request_sha256: "0".repeat(64) },
    { ...original, request: { ...original.request, expected_episode_generation: request.expected_episode_generation! + 1 } },
    { ...original, deletion_page: { ...original.deletion_page, scope_index: 1 } },
    { ...original, deletion_page: { ...original.deletion_page, payload_objects: 2 } },
    { ...original, deletion_page: undefined },
    { ...original, authorizes_operation: true },
    { ...original, secret: "server-secret" },
  ];
  let calls = 0;
  for (const variant of variants) {
    const client = new LifecycleAdminClient(setup.config, "private-secret", async () => { calls += 1; return json(variant); });
    await expect(client.dryRun(input)).rejects.toThrow("response was not verified");
  }
  expect(calls).toBe(variants.length);
});

test("client rejects changed operation receipts and an unexpected result after one send", async () => {
  const setup = await lifecycleAdminFixture();
  const input = await body(setup, "claim", await setup.operationRequest("episode", "unpublish"));
  const original = await setup.success(input);
  if (original.result !== "claimed") throw new Error("Expected claim");
  const variants = [
    { ...original, service_id: "foreign" },
    { ...original, operation: { ...original.operation, job_id: crypto.randomUUID() } },
    { ...original, operation: { ...original.operation, show_generation: original.operation.show_generation + 1 } },
    { ...original, operation: { ...original.operation, episode_id: "untouched" } },
    { ...original, operation: { ...original.operation, action: "delete" } },
    { ...original, operation: { ...original.operation, request_sha256: "0".repeat(64) } },
    { ...original, result: "committed", key: `staging/lifecycle/episodes/daily/next/${input.request.job_id}/commit.json`, created: true },
  ];
  let calls = 0;
  for (const variant of variants) {
    const client = new LifecycleAdminClient(setup.config, "private-secret", async () => { calls += 1; return json(variant); });
    await expect(client.claim(input)).rejects.toThrow("response was not verified");
  }
  expect(calls).toBe(variants.length);
});

test("client discards HTTP and transport diagnostics and never automatically retries", async () => {
  const setup = await lifecycleAdminFixture();
  const input = await body(setup, "claim", await setup.operationRequest("episode", "unpublish"));
  let calls = 0;
  let cancelled = 0;
  for (const status of [301, 401, 409, 500]) {
    const client = new LifecycleAdminClient(setup.config, "private-secret", (async () => {
      calls += 1;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("server-secret")); },
        cancel() { cancelled += 1; } }), { status });
    }));
    await expect(client.claim(input)).rejects.toThrow("response was not verified");
  }
  const client = new LifecycleAdminClient(setup.config, "private-secret", (async () => {
    calls += 1;
    throw new Error("server-secret private-secret");
  }));
  await expect(client.claim(input)).rejects.toThrow("outcome is unknown");
  expect(calls).toBe(5);
  expect(cancelled).toBe(4);
});

test("client bounds response bytes and awaits stream cancellation", async () => {
  const setup = await lifecycleAdminFixture();
  const input = await body(setup, "dry-run", await setup.operationRequest("episode", "delete"));
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  let settled = false;
  const client = new LifecycleAdminClient(setup.config, "private-secret", (async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(65537)); },
    async cancel() { enter(); await released; },
  }), { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } })));
  const result = client.dryRun(input).catch((error: unknown) => { settled = true; return error; });
  await entered;
  expect(settled).toBe(false);
  release();
  const error = await result;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("response was not verified");
});

test("client rejects missing cache/type headers, declared oversize and invalid JSON/UTF-8", async () => {
  const setup = await lifecycleAdminFixture();
  const input = await body(setup, "dry-run", await setup.operationRequest("episode", "delete"));
  const original = await setup.success(input);
  const responses = [
    Response.json(original), json(original, { "Cache-Control": "public, max-age=3600" }),
    json(original, { "Content-Type": "text/plain" }), json(original, { "Content-Length": "65537" }),
    json(original, { "Content-Length": "invalid" }),
    new Response("not-json", { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } }),
    new Response(Uint8Array.of(0xc3, 0x28), { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } }),
    new Response(null, { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } }),
  ];
  for (const response of responses) {
    const client = new LifecycleAdminClient(setup.config, "private-secret", async () => response);
    await expect(client.dryRun(input)).rejects.toThrow("response was not verified");
  }
});

test("client keeps a remotely committed marker after response loss without resending", async () => {
  const setup = await lifecycleAdminFixture();
  const request = await setup.operationRequest("episode", "delete");
  const calls: Request[] = [];
  const client = new LifecycleAdminClient(setup.config, "private-secret", transport(setup, calls));
  await client.claim(await body(setup, "claim", request));
  let sends = 0;
  const uncertain = new LifecycleAdminClient(setup.config, "private-secret", (async (input, init) => {
    sends += 1;
    const response = await transport(setup, calls)(input, init);
    await response.body?.cancel();
    throw new Error("Lost HTTP response containing server-secret");
  }));
  await expect(uncertain.commit(await body(setup, "commit", request))).rejects.toThrow("outcome is unknown");
  const observed = await client.status(await body(setup, "status", request));
  expect(observed.marker_present).toBe(true);
  expect(observed.ownership).toBe("held");
  expect(observed.authorizes_retry).toBe(false);
  expect(sends).toBe(1);
  expect(setup.continuations).toEqual([]);
});

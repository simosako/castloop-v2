import { expect, test } from "bun:test";
import { stageUploadRequestSchema, stagingAdminRequestSchema, stagingAdminResponseSchema } from "@castloop/shared";
import { handleM6StagingAdmin } from "../../../src/staging-admin";
import { readShowControl } from "../../../src/lifecycle-control";
import { stagingAdminFixture } from "../../../src/test-support/staging-admin";
import { publicationTestDigest } from "../../../src/test-support/episode-publication";
import { StagingAdminClient } from "./staging-client";
import type { M6AdminTransport } from "./m6-admin-json";

type Setup = Awaited<ReturnType<typeof stagingAdminFixture>>;
function transport(setup: Setup, calls: string[]): M6AdminTransport {
  return async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe(new URL("/admin/staging", setup.config.public_base_url).href);
    expect(request.redirect).toBe("error");
    expect(request.cache).toBe("no-store");
    expect(request.headers.get("X-Castloop-Key")).toBe("private-secret");
    const body = stagingAdminRequestSchema.parse(await request.clone().json());
    calls.push(body.action);
    const response = await handleM6StagingAdmin(request, setup.env, setup.bindings, { digest: publicationTestDigest });
    if (!response) throw new Error("Expected internal staging route");
    return response;
  };
}

for (const kind of ["show", "audio", "episode_metadata"] as const) {
  test(`internal staging client binds ${kind} admission, PUT targets and completion to its manifest`, async () => {
    const setup = await stagingAdminFixture(kind);
    const calls: string[] = [];
    const client = new StagingAdminClient(setup.config, "private-secret", transport(setup, calls));
    expect((await client.claim(setup.upload)).operation).toEqual(setup.operation);
    const started = await client.begin(setup.upload);
    expect(started.payloads.map((item) => item.sha256)).toEqual(setup.upload.payloads.map((item) => item.sha256));
    const writes = setup.writes.length;
    const status = await client.status(setup.upload);
    expect(status.ownership).toBe("held");
    expect(status.authorizes_put).toBe(false);
    expect(setup.writes.length).toBe(writes);
    await setup.putPayloads();
    await client.settle(setup.upload, { put_requests_settled: true, no_more_puts: true });
    expect((await client.finish(setup.upload, "staged")).result).toBe("staged");
    expect((await client.status(setup.upload)).ownership).toBe("released");
    expect((await readShowControl(setup.env, "daily"))!.value.owner).toBeUndefined();
    expect(calls).toEqual(["claim", "begin", "status", "settle", "finish", "status"]);
  });
}

test("client rejects another draft/episode, lengths, checksums and reordered targets in PUT permission", async () => {
  const setup = await stagingAdminFixture();
  const calls: string[] = [];
  const client = new StagingAdminClient(setup.config, "private-secret", transport(setup, calls));
  await client.claim(setup.upload);
  const original = await client.begin(setup.upload);
  const variants = [
    { ...original, service_id: "foreign" },
    { ...original, operation: { ...original.operation, show_generation: original.operation.show_generation + 1 } },
    { ...original, payloads: original.payloads.map((item) => ({ ...item, key: item.key.replace(setup.upload.draft_job_id, crypto.randomUUID()) })) },
    { ...original, payloads: original.payloads.map((item) => ({ ...item, length: item.length + 1 })) },
    { ...original, payloads: original.payloads.map((item) => ({ ...item, sha256: "0".repeat(64) })) },
    { ...original, payloads: [...original.payloads].reverse() },
    { ...original, payloads: original.payloads.slice(0, 1) },
  ];
  for (const variant of variants) {
    let sends = 0;
    const fake = new StagingAdminClient(setup.config, "private-secret", async () => {
      sends += 1; return Response.json(variant, { headers: { "Cache-Control": "no-store" } });
    });
    await expect(fake.begin(setup.upload)).rejects.toThrow("response was not verified");
    expect(sends).toBe(1);
  }
  const episode = stageUploadRequestSchema.parse({ ...setup.upload, kind: "episode", episode_id: "next", expected_episode_generation: 0,
    payloads: [{ asset: "audio", length_bytes: 3, sha256: "a".repeat(64) }] });
  const wrong = { ...original, payloads: [{ key: `staging/episodes/daily/foreign/${episode.draft_job_id}/audio.mp3`, length: 3, sha256: "a".repeat(64) }] };
  const fake = new StagingAdminClient(setup.config, "private-secret", async () => Response.json(wrong, { headers: { "Cache-Control": "no-store" } }));
  await expect(fake.begin(episode)).rejects.toThrow("response was not verified");
});

test("client validates manifests, bounds and explicit settlement before sending", async () => {
  const setup = await stagingAdminFixture("audio");
  let sends = 0;
  const client = new StagingAdminClient(setup.config, "private-secret", async () => { sends += 1; throw new Error("Must not send"); });
  for (const upload of [{ ...setup.upload, operation_id: setup.upload.draft_job_id },
    { ...setup.upload, expected_show_generation: Number.MAX_SAFE_INTEGER },
    { ...setup.upload, payloads: [{ ...setup.upload.payloads[0], length_bytes: 300000001 }] },
    { ...setup.upload, title: "Private description" }]) {
    await expect(client.claim(upload as never)).rejects.toThrow();
  }
  await expect(client.settle(setup.upload, { put_requests_settled: false, no_more_puts: true } as never)).rejects.toThrow();
  await expect(client.settle(setup.upload, { put_requests_settled: true } as never)).rejects.toThrow();
  await expect(client.finish(setup.upload, "published" as never)).rejects.toThrow();
  expect(sends).toBe(0);
});

test("client binds status to both manifest and control request hashes and rejects false authorization", async () => {
  const setup = await stagingAdminFixture("audio");
  await setup.success(setup.input("claim", { upload: setup.upload }));
  const original = await setup.success(setup.input("status", { upload: setup.upload }));
  if (original.result !== "status") throw new Error("Expected status");
  for (const variant of [{ ...original, manifest_sha256: "0".repeat(64), progress: null },
    { ...original, request_sha256: "0".repeat(64) }, { ...original, upload: { ...original.upload, draft_job_id: crypto.randomUUID() } },
    { ...original, authorizes_put: true }, { ...original, authorizes_recovery: true },
    { ...original, verification_active: true, ownership: "released" }]) {
    const client = new StagingAdminClient(setup.config, "private-secret", async () => Response.json(variant, { headers: { "Cache-Control": "no-store" } }));
    await expect(client.status(setup.upload)).rejects.toThrow("response was not verified");
  }
  expect(stagingAdminResponseSchema.safeParse({ ...original, status: { secret: "private-secret" } }).success).toBe(false);
});

test("client does not replay begin after a successful remote change and a lost response", async () => {
  const setup = await stagingAdminFixture();
  const calls: string[] = [];
  const client = new StagingAdminClient(setup.config, "private-secret", transport(setup, calls));
  await client.claim(setup.upload);
  let sends = 0;
  const uncertain = new StagingAdminClient(setup.config, "private-secret", async (input, init) => {
    sends += 1;
    const response = await transport(setup, calls)(input, init);
    await response.body?.cancel();
    throw new Error("private-secret lost response");
  });
  await expect(uncertain.begin(setup.upload)).rejects.toThrow("outcome is unknown");
  const status = await client.status(setup.upload);
  expect(status.progress?.phase).toBe("uploading");
  expect(status.authorizes_put).toBe(false);
  expect(sends).toBe(1);
  expect(calls).toEqual(["claim", "begin", "status"]);
});

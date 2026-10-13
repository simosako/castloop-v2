import { describe, expect, spyOn, test } from "bun:test";
import { publicationManifestHash, stageUploadRequestSchema } from "../packages/shared/src/index";
import { readShowControl, withReservedPublicationControlEnv } from "./lifecycle-control";
import type { LifecycleControlEnv } from "./lifecycle-control";
import { claimPublicationOperation, commitOwnedPublication, requireOwnedPublication, withPublicationCommitContext } from "./publication-admission";
import { publicationAdminFixture } from "./test-support/publication-admin";

const controlKey = "system/show-publications/daily.json";
const reservationKey = "system/show-reservations/daily.json";

async function fixture(mode: "show" | "episode" | "metadata" | "audio" = "episode") {
  const setup = await publicationAdminFixture(mode);
  const operation = await claimPublicationOperation(setup.env, setup.frozen);
  const saved = (await readShowControl(setup.env, "daily"))!.value;
  const reservationId = crypto.randomUUID();
  await setup.bucket.put(controlKey, JSON.stringify({ ...saved, reservation_id: reservationId }));
  await setup.bucket.put(reservationKey, JSON.stringify({ show_id: "daily", reservation_id: reservationId }));
  return { ...setup, operation, saved: { ...saved, reservation_id: reservationId } };
}

describe("request-scoped publication commit inputs", () => {
  for (const mode of ["show", "episode", "metadata", "audio"] as const) {
    test(`${mode}: reuses immutable inputs without removing mutable guards or HEAD checks`, async () => {
      const measurements: Array<{ request: number; publication: number; reservation: number; show: number; episode: number; heads: number }> = [];
      for (const scoped of [false, true]) {
        const setup = await fixture(mode);
        const get = spyOn(setup.bucket, "get");
        const head = spyOn(setup.bucket, "head");
        const parse = spyOn(stageUploadRequestSchema, "parse");
        try {
          const expectedHash = await publicationManifestHash(setup.frozen);
          const commit = async (env: typeof setup.env, manifestHash: string) => {
            expect(manifestHash).toBe(expectedHash);
            const result = await commitOwnedPublication(env, setup.operation);
            expect(result).toEqual({ key: setup.markerKey, created: true });
          };
          if (scoped) await withPublicationCommitContext(setup.env, setup.operation, commit);
          else {
            const owned = await requireOwnedPublication(setup.env, setup.operation);
            await commit(setup.env, await publicationManifestHash(owned.frozen));
          }
          const calls = (key: string) => get.mock.calls.filter(([value]) => value === key).length;
          measurements.push({ request: calls(`system/jobs/${setup.operation.jobId}/request.toml`),
            publication: calls(`system/jobs/${setup.operation.jobId}/publication.json`), reservation: calls(reservationKey),
            show: calls(controlKey), episode: calls("system/episode-lifecycle/daily/next.toml"), heads: head.mock.calls.length });
          expect(parse.mock.calls).toHaveLength(setup.stages.length);
          expect(JSON.parse(await (await setup.env.CASTLOOP_BUCKET.get(setup.markerKey))!.text())).toEqual(setup.frozen.commit);
        } finally { get.mockRestore(); head.mockRestore(); parse.mockRestore(); }
      }
      expect(measurements[0]).toMatchObject({ request: 5, publication: 5, reservation: 5 });
      expect(measurements[1]).toEqual({ ...measurements[0]!, request: 1, publication: 1, reservation: 1 });
    });
  }

  test("scope cannot escape its callback, nest, change bucket or target, or mutate cached inputs", async () => {
    const setup = await fixture();
    let escaped: LifecycleControlEnv | undefined;
    await withPublicationCommitContext(setup.env, setup.operation, async (scoped) => {
      escaped = scoped;
      await expect(withPublicationCommitContext(scoped, setup.operation, async () => {})).rejects.toThrow();
      for (const operation of [{ ...setup.operation, jobId: crypto.randomUUID() }, { ...setup.operation, showId: "other" },
        { ...setup.operation, generation: setup.operation.generation + 1 }]) {
        await expect(requireOwnedPublication(scoped, operation)).rejects.toThrow();
      }
      await expect(requireOwnedPublication({ ...scoped, CASTLOOP_BUCKET: { ...setup.env.CASTLOOP_BUCKET } }, setup.operation)).rejects.toThrow();
      const owned = await requireOwnedPublication(scoped, setup.operation);
      for (const value of [owned.frozen, owned.frozen.request, owned.frozen.commit, owned.frozen.staged_uploads]) {
        expect(Object.isFrozen(value)).toBe(true);
      }
    });
    await expect(requireOwnedPublication(escaped!, setup.operation)).rejects.toThrow();
    await expect(withPublicationCommitContext(setup.env, setup.operation, async (scoped) => {
      escaped = scoped;
      throw new Error("Test failure");
    })).rejects.toThrow("Test failure");
    await expect(requireOwnedPublication(escaped!, setup.operation)).rejects.toThrow();
    const owned = await requireOwnedPublication(setup.env, setup.operation);
    await expect(withReservedPublicationControlEnv(setup.env, { value: owned.control.value, etag: owned.control.etag },
      async () => {})).rejects.toThrow("validated reserved");
  });

  test("current owner, reservation identity, lifecycle and generation changes still block writes", async () => {
    for (const fault of ["job", "generation", "hash", "reservation", "execution", "show", "episode"] as const) {
      const setup = await fixture();
      await expect(withPublicationCommitContext(setup.env, setup.operation, async (scoped) => {
        const saved = setup.saved;
        const owner = saved.owner!;
        const changed = fault === "job" ? { ...saved, owner: { ...owner, job_id: crypto.randomUUID() } } :
          fault === "generation" ? { ...saved, generation: saved.generation + 1 } :
          fault === "hash" ? { ...saved, owner: { ...owner, request_sha256: "a".repeat(64) } } :
          fault === "reservation" ? { ...saved, reservation_id: crypto.randomUUID() } :
          fault === "execution" ? { ...saved, owner: { ...owner, state: "processing", execution_id: crypto.randomUUID() } } :
          fault === "show" ? { ...saved, lifecycle: "unpublished" } : saved;
        await setup.bucket.put(controlKey, JSON.stringify(changed));
        if (fault === "episode") await setup.bucket.put("system/episode-lifecycle/daily/next.toml",
          "schema_version = 1\nshow_id = 'daily'\nepisode_id = 'next'\nlifecycle = 'unpublished'\ngeneration = 1\n");
        await commitOwnedPublication(scoped, setup.operation);
      })).rejects.toThrow();
      expect(setup.entries.has(setup.markerKey)).toBe(false);
    }
  });

  test("final owner check and staged version/size checks remain effective", async () => {
    for (const fault of ["owner", "version", "size"] as const) {
      const setup = await fixture();
      const original = setup.bucket.head.bind(setup.bucket);
      const head = spyOn(setup.bucket, "head").mockImplementation(async (...args) => {
        const result = await original(...args);
        if (!result || !args[0].endsWith("audio.mp3")) return result;
        if (fault === "owner") {
          await setup.bucket.put(controlKey, JSON.stringify({ ...setup.saved,
            owner: { ...setup.saved.owner!, request_sha256: "a".repeat(64) } }));
          return result;
        }
        return { ...result, ...(fault === "size" ? { size: result.size + 1 } : { version: "changed-version" }) };
      });
      try {
        await expect(withPublicationCommitContext(setup.env, setup.operation,
          (scoped) => commitOwnedPublication(scoped, setup.operation))).rejects.toThrow();
        expect(setup.entries.has(setup.markerKey)).toBe(false);
      } finally { head.mockRestore(); }
    }
  });

  test("missing, oversized, changed and unregistered initial immutable inputs are rejected", async () => {
    for (const fault of ["missing", "oversized", "control", "manifest", "reservation"] as const) {
      const setup = await fixture();
      const key = `system/jobs/${setup.operation.jobId}/${fault === "control" ? "request.toml" : "publication.json"}`;
      if (fault === "missing") setup.entries.delete(key);
      else if (fault === "oversized") await setup.bucket.put(key, "x".repeat(16385));
      else if (fault === "reservation") setup.entries.delete(reservationKey);
      else if (fault === "control") {
        const source = await (await setup.env.CASTLOOP_BUCKET.get(key))!.text();
        await setup.bucket.put(key, source.replace(setup.operation.jobId, crypto.randomUUID()));
      } else await setup.bucket.put(key, JSON.stringify({ ...setup.frozen, request: { ...setup.frozen.request, created_at: "2026-10-03T12:00:00Z" } }));
      await expect(withPublicationCommitContext(setup.env, setup.operation, async () => {})).rejects.toThrow();
      expect(setup.entries.has(setup.markerKey)).toBe(false);
    }
  });

  test("existing markers and lost conditional PUT receipts remain idempotent", async () => {
    const setup = await fixture();
    const original = setup.bucket.put.bind(setup.bucket);
    const put = spyOn(setup.bucket, "put").mockImplementation(async (...args) => {
      const result = await original(...args);
      return args[0] === setup.markerKey ? null : result;
    });
    try {
      expect(await withPublicationCommitContext(setup.env, setup.operation,
        (scoped) => commitOwnedPublication(scoped, setup.operation))).toEqual({ key: setup.markerKey, created: false });
    } finally { put.mockRestore(); }
    await setup.bucket.put(controlKey, JSON.stringify({ ...setup.saved,
      owner: { ...setup.saved.owner!, state: "processing", execution_id: crypto.randomUUID() } }));
    expect(await withPublicationCommitContext(setup.env, setup.operation,
      (scoped) => commitOwnedPublication(scoped, setup.operation))).toEqual({ key: setup.markerKey, created: false });
    await setup.bucket.put(setup.markerKey, JSON.stringify({ ...setup.frozen.commit, audio_sha256: "b".repeat(64) }));
    await expect(withPublicationCommitContext(setup.env, setup.operation,
      (scoped) => commitOwnedPublication(scoped, setup.operation))).rejects.toThrow();
  });

  test("pending commit IO keeps its scope active until settlement without releasing admission", async () => {
    const setup = await fixture();
    let settle: () => void;
    let started: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const original = setup.bucket.put.bind(setup.bucket);
    const put = spyOn(setup.bucket, "put").mockImplementation(async (...args) => {
      if (args[0] === setup.markerKey) { started(); await pending; }
      return original(...args);
    });
    let escaped: LifecycleControlEnv | undefined;
    let finished = false;
    const running = withPublicationCommitContext(setup.env, setup.operation, async (scoped) => {
      escaped = scoped;
      const result = await commitOwnedPublication(scoped, setup.operation);
      finished = true;
      return result;
    });
    try {
      await entered;
      expect(finished).toBe(false);
      expect(setup.entries.has(setup.markerKey)).toBe(false);
      expect((await requireOwnedPublication(escaped!, setup.operation)).control.value.owner.state).toBe("reserved");
      settle!();
      await running;
      await expect(requireOwnedPublication(escaped!, setup.operation)).rejects.toThrow();
      expect((await readShowControl(setup.env, "daily"))!.value.owner?.job_id).toBe(setup.operation.jobId);
    } finally { settle!(); await running; put.mockRestore(); }
  });
});

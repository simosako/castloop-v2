import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import type { ControlRequest } from "../../packages/shared/src/index";
import { CloudflareProbe } from "./probe-harness";

const probe = new CloudflareProbe();
const checks: string[] = [];
let failure: string | undefined;
let uploadEvidence: unknown;

function request(showId: string, action: ControlRequest["action"] = "unpublish", generation = 0): ControlRequest {
  return { schema_version: 1, job_id: crypto.randomUUID(), show_id: showId, kind: "show", action,
    expected_show_generation: generation, created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
}

function passed(name: string): void { checks.push(name); console.log(`PASS ${name}`); }

async function settled<T>(calls: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(calls);
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

try {
  await probe.start(resolve(import.meta.dir, "admission-worker.ts"));
  const show = "probe-arbitration";
  await probe.ok("seed", { show_id: show });
  const contenders = Array.from({ length: 16 }, (_, index) => request(show,
    (["publish", "stage", "unpublish", "delete"] as const)[index % 4]));
  const results = await settled(contenders.map((input) => probe.call("claim", { show_id: show, request: input })));
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert.equal(results.filter((result) => result.status === 409).length, 15);
  passed("R2 CAS admits exactly one of 16 publication/staging/lifecycle contenders");

  const sameShow = "probe-idempotent";
  await probe.ok("seed", { show_id: sameShow });
  const input = request(sameShow);
  const duplicates = await settled(Array.from({ length: 6 }, () =>
    probe.call("claim", { show_id: sameShow, request: input })));
  assert.ok(duplicates.every((result) => result.status === 200));
  assert.equal((duplicates[0].data.value as { generation: number }).generation, 1);
  await probe.ok("begin", { show_id: sameShow, job_id: input.job_id, generation: 1 });
  assert.equal((await probe.call("abandon", { show_id: sameShow, job_id: input.job_id, generation: 1 })).status, 409);
  passed("same-request CAS retries are idempotent; processing cannot be abandoned");

  const abandonedShow = "probe-abandoned";
  await probe.ok("seed", { show_id: abandonedShow });
  const abandoned = request(abandonedShow);
  await probe.ok("claim", { show_id: abandonedShow, request: abandoned });
  assert.equal((await probe.call("abandon-lost", { show_id: abandonedShow, job_id: abandoned.job_id, generation: 1 })).status, 503);
  const recovered = await probe.ok("abandon", { show_id: abandonedShow, job_id: abandoned.job_id, generation: 1 });
  assert.equal((recovered.value as { generation: number }).generation, 2);
  assert.equal((await probe.call("begin", { show_id: abandonedShow, job_id: abandoned.job_id, generation: 1 })).status, 409);
  assert.equal((await probe.call("claim", { show_id: abandonedShow, request: abandoned })).status, 409);
  assert.equal((await probe.call("claim", { show_id: abandonedShow,
    request: { ...abandoned, expected_show_generation: 2 } })).status, 409);
  await probe.ok("claim", { show_id: abandonedShow, request: request(abandonedShow, "delete", 2) });
  passed("lost abandon response recovers; stale begin, same job reclaim and generation rewrite are rejected");

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const racingShow = `probe-race-${attempt}`;
    await probe.ok("seed", { show_id: racingShow });
    const racing = request(racingShow);
    await probe.ok("claim", { show_id: racingShow, request: racing });
    const actions = attempt % 2 ? ["begin", "abandon"] : ["abandon", "begin"];
    const race = await settled(actions.map((action) => probe.call(action,
      { show_id: racingShow, job_id: racing.job_id, generation: 1 })));
    assert.equal(race.filter((result) => result.status === 200).length, 1);
    assert.equal(race.filter((result) => result.status === 409).length, 1);
  }
  passed("begin versus abandon CAS has one winner across eight real R2 races");

  const uploadingShow = "probe-uploading";
  await probe.ok("seed", { show_id: uploadingShow });
  const uploading = request(uploadingShow, "stage");
  await probe.ok("claim", { show_id: uploadingShow, request: uploading });
  assert.equal((await probe.call("abandon", { show_id: uploadingShow, job_id: uploading.job_id, generation: 1 })).status, 409);
  assert.equal((await probe.call("claim", { show_id: uploadingShow,
    request: request(uploadingShow, "delete", 1) })).status, 409);
  passed("uploading ownership blocks deletion and cannot be force released");

  const key = "probe/rest-conditional";
  const initial = await probe.objectPut(key, "barrier", { "Content-Length": "7" });
  assert.ok(initial.ok, `REST initial upload: ${initial.status}`);
  await initial.arrayBuffer();
  const before = await probe.ok("object", { key });
  const mismatched = await probe.objectPut(key, "wrong", { "Content-Length": "5", "If-Match": '"not-the-current-etag"' });
  const mismatchStatus = mismatched.status;
  await mismatched.arrayBuffer();
  const after = await probe.ok("object", { key });
  uploadEvidence = { mismatchedIfMatchStatus: mismatchStatus, before, after,
    conditionalRestSupported: mismatchStatus === 412 && after.etag === before.etag };
  if (mismatchStatus !== 412 || after.etag !== before.etag) {
    console.log("GATE BLOCKED: R2 REST object PUT did not enforce If-Match; no upload fencing/release is enabled");
  } else {
    passed("REST object PUT enforces If-Match; streaming interruption proof remains required");
  }
} catch (error) {
  failure = String(error);
  console.error(failure);
} finally {
  const cleanupErrors = await probe.cleanup();
  await probe.saveResult({ checks, uploadEvidence, failure, cleanupErrors, cleanedUp: cleanupErrors.length === 0 });
  if (failure || cleanupErrors.length) process.exitCode = 1;
}

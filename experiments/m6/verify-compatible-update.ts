import { m6RuntimeReadinessSchema, m6ServiceAdminResponseSchema, parseServiceConfig, targetInspectionResponseSchema } from "../../packages/shared/src/index";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

if (process.argv.length !== 3) throw new Error("Provide one explicitly acknowledged fresh-binary workspace");
const root = resolve(process.argv[2]!);
const binary = resolve("dist/castloop-m6-test-linux-x64");
const config = parseServiceConfig(await readFile(join(root, "castloop.toml"), "utf8"));
const acceptance = JSON.parse(await readFile(join(root, "acceptance.json"), "utf8")) as { result: string; name: string; pause_id: string };
if (acceptance.result !== "fresh_binary_publication_passed" || acceptance.name !== config.worker_name ||
  config.account_id !== process.env.CLOUDFLARE_ACCOUNT_ID || !config.worker_name.startsWith("castloop-m6-test-")) {
  throw new Error("Compatible acceptance requires its isolated, acknowledged and paused fresh service");
}
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error("Cloudflare administration credentials are required");
const operationId = crypto.randomUUID();
const observations: Array<{ command: string; result: string }> = [];
let phase = "preflight";
async function command(...args: string[]): Promise<string> {
  const child = Bun.spawn([binary, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code) { console.error(error); throw new Error("Compatible binary command was not acknowledged; do not replay it"); }
  observations.push({ command: args[0]!, result: "confirmed" });
  return output.trim();
}
const status = async () => m6ServiceAdminResponseSchema.parse(JSON.parse(await command("service-status")));
const target = async () => targetInspectionResponseSchema.parse(JSON.parse(await command("target-episode", "fresh", "first")));
async function digestResponse(response: Response): Promise<{ bytes: number; sha256: string }> {
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const hash = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      assert.ok(bytes <= 2_000_000, "This isolated acceptance uses only small known fixtures");
      hash.update(chunk.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return { bytes, sha256: hash.digest("hex") };
}
try {
  const before = await status();
  assert.equal(before.admission.state, "paused");
  assert.equal(before.admission.pause_id, acceptance.pause_id);
  assert.equal(before.admission.invocations.length, 0);
  const original = await target();
  assert.equal(original.unfinished_show_operation, false);
  assert.equal(original.episode?.lifecycle, "active");
  assert.ok(original.current_revision);
  const revision = original.current_revision;
  const keys = ["system/service.toml", "system/shows/fresh/show.toml", "system/show-publications/fresh.json",
    "system/show-reservations/fresh.json", "system/episode-lifecycle/fresh/first.toml", "public/episodes/fresh/first/metadata.toml",
    `public/episodes/fresh/first/revisions/${revision.revision_id}.toml`, "public/podcasts/fresh/feed.xml", "public/podcasts/fresh/cover.png",
    `public/podcasts/fresh/episodes/first/${revision.revision_id}.mp3`];
  const snapshot = async () => {
    const objects = [];
    for (const key of keys) {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.account_id}/r2/buckets/${config.bucket_name}/objects/${key}`, {
        headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "identity" }, redirect: "error", signal: AbortSignal.timeout(30000),
      });
      objects.push({ key, etag: response.headers.get("ETag"), ...await digestResponse(response) });
    }
    return objects;
  };
  const payloads = await snapshot();
  await writeFile(join(root, "compatible-update-before.json"), JSON.stringify({ operation_id: operationId, payloads }, null, 2), { mode: 0o600, flag: "wx" });
  phase = "update-request";
  const result = JSON.parse(await command("update-service", operationId)) as { result: string; runtime_readiness: unknown };
  phase = "paused-receipt-verification";
  assert.equal(result.result, "updated-paused");
  const readiness = m6RuntimeReadinessSchema.parse(result.runtime_readiness);
  assert.equal(readiness.operation_id, operationId);
  assert.notEqual(readiness.worker_version_id, before.worker_version_id);
  const completed = await status();
  assert.equal(completed.worker_version_id, readiness.worker_version_id);
  assert.equal(completed.admission.state, "paused");
  assert.equal(completed.admission.invocations.length, 0);
  assert.deepEqual(completed.admission.runtime_readiness, readiness);
  assert.deepEqual(await target(), original);
  assert.deepEqual(await snapshot(), payloads);
  phase = "explicit-resume";
  await command("service-resume", acceptance.pause_id);
  phase = "public-delivery-verification";
  for (const path of ["/podcasts/fresh/feed.xml", "/podcasts/fresh/cover.png", new URL(revision.enclosure_url).pathname]) {
    const response = await fetch(new URL(path, config.public_base_url), { redirect: "error", signal: AbortSignal.timeout(30000) });
    assert.equal(response.headers.get("X-Castloop-Worker-Version"), readiness.worker_version_id);
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=0, must-revalidate");
    const actual = await digestResponse(response);
    const expected = payloads.find((object) => object.key === `public${path}`)!;
    assert.equal(actual.sha256, expected.sha256);
    assert.equal(actual.bytes, expected.bytes);
  }
  const pauseId = crypto.randomUUID();
  phase = "explicit-pause";
  await command("service-pause", pauseId);
  assert.equal((await status()).admission.invocations.length, 0);
  await writeFile(join(root, "compatible-update-acceptance.json"), JSON.stringify({ result: "compatible_binary_update_passed", operation_id: operationId,
    name: config.worker_name, previous_worker_version_id: before.worker_version_id, runtime_readiness: readiness, pause_id: pauseId,
    objects_unchanged: payloads.length, observations, guid_revision_url_preserved: true, resources_retained_paused: true, authorizes_release: false }, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ result: "compatible_binary_update_passed", workspace: root, resources_retained_paused: true }));
} catch {
  await writeFile(join(root, "compatible-update-incomplete.json"), JSON.stringify({ result: "compatible_acceptance_incomplete", operation_id: operationId,
    phase, observations, resources_not_deleted: true, authorizes_recovery: false }, null, 2), { mode: 0o600, flag: "wx" });
  console.error(`Compatible acceptance did not complete (${phase}). Preserve deployment/requested journals and owners; no automatic replay, rollback or resume.`);
  process.exitCode = 1;
}

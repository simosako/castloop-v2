import { m6ServiceAdminResponseSchema, parseEpisodeDraft, parseServiceConfig, parseShowMetadata, serviceConfigSchema,
  stringifyToml, targetInspectionResponseSchema } from "../../packages/shared/src/index";
import { readLocalDraft } from "../../packages/cli/src/local-draft-journal";
import { readLocalPublicationJob } from "../../packages/cli/src/publication-journal";
import { readLocalFreshM6Initialization } from "../../packages/cli/src/m6-service-initialization";
import { readLocalShowRegistration } from "../../packages/cli/src/show-registration-journal";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error("Cloudflare administration credentials are required");
const publishedEpisode = process.argv[2] === "--published-episode-workspace";
const publishedShow = publishedEpisode || process.argv[2] === "--published-show-workspace";
const continuing = publishedShow || process.argv[2] === "--initialized-workspace";
if (continuing && (process.argv.length !== 4 || !process.argv[3])) throw new Error("A single explicit continuation workspace is required");
const existingWorkspace = continuing ? resolve(process.argv[3]!) : undefined;
const binary = resolve(existingWorkspace ? "dist/castloop-m6-test-linux-x64" : process.argv[2] ?? "dist/castloop-m6-test-linux-x64");
const suffix = crypto.randomUUID().slice(0, 8);
const existingConfig = existingWorkspace ? parseServiceConfig(await readFile(join(existingWorkspace, "castloop.toml"), "utf8")) : undefined;
const name = existingConfig?.worker_name ?? `castloop-m6-test-${suffix}`;
const directory = existingWorkspace ?? join("/tmp/opencode", name);
const retained = existingConfig ? readLocalFreshM6Initialization(directory, existingConfig) : undefined;
if (existingConfig && (retained?.state?.phase !== "initialized" || retained.lockPresent || existingConfig.account_id !== account ||
  !name.startsWith("castloop-m6-test-") || !publishedShow && readLocalShowRegistration(directory, existingConfig, "fresh").client_state ||
  readLocalShowRegistration(directory, existingConfig, "fresh").lock_present)) throw new Error("Continuation requires acknowledged initialization and its exact completed checkpoint");
function acknowledgedJob(kind: "show" | "episode") {
  if (!existingConfig) throw new Error("Acknowledged continuation needs its retained configuration");
  const draft = readLocalDraft(directory, existingConfig, { kind, show_id: "fresh", ...(kind === "episode" ? { episode_id: "first" } : {}) });
  const job = draft.client_state ? readLocalPublicationJob(directory, existingConfig, draft.client_state.draft_job_id) : undefined;
  if (draft.lock_present || draft.client_state?.phase !== "frozen" || job?.lock_present || job?.client_state?.phase !== "committed") {
    throw new Error("Continuation cannot replay an unfinished content command");
  }
  return job.client_state;
}
if (publishedShow) {
  acknowledgedJob("show");
  if (publishedEpisode) acknowledgedJob("episode");
  else if (existsSync(join(directory, "fresh", "episode-first.toml"))) throw new Error("Episode creation already started; do not replay it");
}
const operationId = retained?.state?.request.operation_id ?? crypto.randomUUID();
const observations: Array<{ command: string; result: string; job_id?: string }> = [];
if (!existingWorkspace) await mkdir(directory, { mode: 0o700 });
console.log(JSON.stringify({ workspace: directory }));

async function command(...args: string[]): Promise<string> {
  const child = Bun.spawn([binary, ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) {
    observations.push({ command: args[0]!, result: "binary_command_failed" });
    console.error(stderr);
    throw new Error("Binary command did not complete; retain workspace/resources without replay");
  }
  observations.push({ command: args[0]!, result: "confirmed" });
  return stdout.trim();
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
try {
  const subdomainResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30000),
  });
  assert.equal(subdomainResponse.status, 200);
  const subdomain = await subdomainResponse.json<{ success: boolean; result: { subdomain: string } }>();
  assert.equal(subdomain.success, true);
  const config = existingConfig ?? serviceConfigSchema.parse({ schema_version: 1, service_id: `m6-test-${suffix}`, account_id: account,
    worker_name: name, bucket_name: name, queue_name: name, dlq_name: `${name}-dlq`,
    public_base_url: `https://${name}.${subdomain.result.subdomain}.workers.dev` });
  if (!existingConfig) {
    await writeFile(join(directory, "castloop.toml"), stringifyToml(config), { mode: 0o600, flag: "wx" });
    await writeFile(join(directory, ".gitignore"), ".castloop/\n*.mp3\n", { flag: "wx" });
  }
  assert.deepEqual(parseServiceConfig(await readFile(join(directory, "castloop.toml"), "utf8")), config);
  if (!existingConfig) {
    const initialized = JSON.parse(await command("init", operationId)) as { result: string };
    assert.equal(initialized.result, "initialized-paused");
  }
  const waitSettledService = async (state: "open" | "paused") => {
    for (let read = 0; read < 180; read += 1) {
      const status = m6ServiceAdminResponseSchema.parse(JSON.parse(await command("service-status")));
      assert.equal(status.admission.state, state);
      if (retained) assert.deepEqual(status.admission.runtime_readiness, retained.state!.runtime_readiness);
      if (!status.admission.invocations.length) return status;
      await Bun.sleep(5000);
    }
    throw new Error("Service invocations are still retained; no release, redeploy or automatic retry is authorized");
  };
  await waitSettledService(existingConfig ? "open" : "paused");
  const waitPublishedTarget = async (kind: "show" | "episode") => {
    for (let read = 0; read < 180; read += 1) {
      const args = kind === "show" ? ["target-show", "fresh"] : ["target-episode", "fresh", "first"];
      const target = targetInspectionResponseSchema.parse(JSON.parse(await command(...args)));
      if (!target.unfinished_show_operation && target.show?.lifecycle === "active" && (kind === "show" || target.episode?.lifecycle === "active")) return target;
      await Bun.sleep(5000);
    }
    throw new Error("Publication ownership is still retained; do not release or repeat its job");
  };
  if (!existingConfig) await command("service-resume", operationId);
  if (!publishedShow) await command("create-show", "fresh", "https://example.com/m6-test");
  const showFile = join(directory, "fresh", "show.toml");
  const show = parseShowMetadata(await readFile(showFile, "utf8"));
  const cover = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=", "base64");
  if (!publishedShow) {
    await writeFile(showFile, stringifyToml({ ...show, image_path: "cover.png" }));
    await writeFile(join(directory, "fresh", "cover.png"), cover);
    await command("update-show", "fresh");
    const showJob = JSON.parse(await command("publish-show", "fresh")) as { job_id: string };
    observations.push({ command: "show-publication", result: "committed", job_id: showJob.job_id });
  } else {
    const target = targetInspectionResponseSchema.parse(JSON.parse(await command("target-episode", "fresh", "first")));
    assert.equal(target.show?.lifecycle, "active");
    assert.equal(target.unfinished_show_operation, false);
    if (!publishedEpisode) {
      assert.equal(target.episode, null);
      assert.equal(target.current_revision, null);
    }
    assert.equal(show.image_path, "cover.png");
    assert.equal(digest(await readFile(join(directory, "fresh", "cover.png"))), digest(cover));
    observations.push({ command: "show-publication", result: "previous_acknowledgment_verified",
      job_id: readLocalDraft(directory, config, { kind: "show", show_id: "fresh" }).client_state!.draft_job_id });
  }
  const publicGet = (path: string, method = "GET", headers: Record<string, string> = {}) => fetch(new URL(path, config.public_base_url), {
    method, headers, redirect: "error", signal: AbortSignal.timeout(30000),
  });
  const waitFeed = async (guid?: string): Promise<string> => {
    for (let read = 0; read < 180; read += 1) {
      const response = await publicGet("/podcasts/fresh/feed.xml");
      const body = await response.text();
      if (response.status === 200 && body.includes("<rss") && (!guid || body.includes(guid))) return body;
      await Bun.sleep(5000);
    }
    throw new Error("Publication is still pending; do not release or repeat its job");
  };
  await waitPublishedTarget("show");
  await waitFeed();
  if (!publishedEpisode) await command("create-episode", "fresh", "first");
  const episode = parseEpisodeDraft(await readFile(join(directory, "fresh", "episode-first.toml"), "utf8"));
  const audio = Buffer.concat(Array.from({ length: 50 }, () => Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)])));
  const audioFile = join(directory, "fresh", "first.mp3");
  let episodeJobId: string;
  if (!publishedEpisode) {
    await writeFile(audioFile, audio);
    await command("update-episode", "fresh", "first");
    await command("update-episode-audio", "fresh", "first", audioFile);
    const episodeJob = JSON.parse(await command("publish-episode", "fresh", "first", audioFile)) as { job_id: string };
    episodeJobId = episodeJob.job_id;
    observations.push({ command: "episode-publication", result: "committed", job_id: episodeJobId });
  } else {
    episodeJobId = acknowledgedJob("episode").publication.request.job_id;
    assert.equal(digest(await readFile(audioFile)), digest(audio));
    observations.push({ command: "episode-publication", result: "previous_acknowledgment_verified", job_id: episodeJobId });
  }
  const target = await waitPublishedTarget("episode");
  assert.equal(target.current_revision?.revision_id, episodeJobId);
  assert.equal(target.current_revision?.guid, episode.guid);
  assert.equal(target.current_revision?.sha256, digest(audio));
  await waitSettledService("open");
  const feed = await waitFeed(episode.guid);
  const mediaUrl = /<enclosure url="([^"]+)"/.exec(feed)?.[1];
  assert.ok(mediaUrl);
  assert.equal(new URL(mediaUrl).origin, config.public_base_url);
  const media = await publicGet(new URL(mediaUrl).pathname);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("Cache-Control"), "public, max-age=0, must-revalidate");
  assert.equal(digest(new Uint8Array(await media.arrayBuffer())), digest(audio));
  const head = await publicGet(new URL(mediaUrl).pathname, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Length"), String(audio.length));
  await head.body?.cancel();
  const range = await publicGet(new URL(mediaUrl).pathname, "GET", { Range: "bytes=0-9" });
  assert.equal(range.status, 206);
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), new Uint8Array(audio.subarray(0, 10)));
  const downloadedCover = await publicGet("/podcasts/fresh/cover.png");
  assert.equal(downloadedCover.status, 200);
  assert.equal(digest(new Uint8Array(await downloadedCover.arrayBuffer())), digest(cover));
  const pauseId = crypto.randomUUID();
  await command("service-pause", pauseId);
  await waitSettledService("paused");
  await writeFile(join(directory, "acceptance.json"), JSON.stringify({ result: "fresh_binary_publication_passed", name, operation_id: operationId,
    pause_id: pauseId, audio_bytes: audio.length, observations, public_delivery: ["feed", "cover", "GET", "HEAD", "Range"],
    continuation_checkpoint: existingWorkspace ? process.argv[2] : "none",
    resources_retained_paused: true, synthetic_mp3_frames: true, authorizes_release: false }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ result: "fresh_binary_publication_passed", workspace: directory, resources_retained_paused: true }));
} catch (error: unknown) {
  await writeFile(join(directory, "acceptance.json"), JSON.stringify({ result: "fresh_binary_acceptance_incomplete", name,
    operation_id: operationId, observations, resources_not_deleted: true, authorizes_recovery: false }, null, 2), { mode: 0o600 });
  console.error("Fresh-service acceptance did not complete. Retain the private workspace and exact resource names; no automatic replay or cleanup.");
  if (error instanceof assert.AssertionError) console.error(error.message);
  process.exitCode = 1;
}

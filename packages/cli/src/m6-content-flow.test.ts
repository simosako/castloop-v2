import { expect, test } from "bun:test";
import { parseEpisodeDraft, parseEpisodeRevision, publicationCommitKey, stringifyToml } from "@castloop/shared";
import type { LifecycleOperationRequest } from "@castloop/shared";
import { LifecycleAdminClient } from "./lifecycle-client";
import { readLocalDraft } from "./local-draft-journal";
import { createM6LocalEpisodeDraft, createM6LocalShowDraft } from "./m6-local-drafts";
import { executeLocalM6Lifecycle, previewLocalM6Lifecycle } from "./m6-local-lifecycle";
import { publishLocalM6Draft, updateLocalM6Draft } from "./m6-local-update";
import { PublicationAdminClient } from "./publication-client";
import { createShowRegistrationJournal } from "./show-registration-journal";
import { createShowRegistrationEffects, runShowRegistration } from "./show-registration-operation";
import { StagingAdminClient } from "./staging-client";
import { TargetInspectionClient } from "./target-inspection-client";
import { controlRequestHash, readEpisodeLifecycle, readShowControl } from "../../../src/lifecycle-control";
import type { LifecyclePurgeTarget } from "../../../src/lifecycle-cache";
import { fetchM6Candidate, fetchM6ManagementIntegration, queueM6Candidate } from "../../../src/m6-routes";
import type { M6CachedLoopback, M6CandidateEnv } from "../../../src/m6-routes";
import { parseQueueDelivery } from "../../../src/queue-delivery";
import { stagingAdminFixture } from "../../../src/test-support/staging-admin";
import { publicationTestDigest } from "../../../src/test-support/episode-publication";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("new Show registration and local drafts flow through staging, publication, revisions and all six lifecycle operations", async () => {
  const setup = await stagingAdminFixture();
  const root = mkdtempSync("/tmp/opencode/castloop-m6-content-flow-");
  const queued: string[] = [];
  const purges: LifecyclePurgeTarget[] = [];
  const cachedAssets: M6CachedLoopback = Object.assign(() => ({ fetch: async () => new Response("simulated public asset") }), {
    invalidate: async (target: LifecyclePurgeTarget) => { purges.push(target); }, ...setup.bindings.cachedAssets,
  });
  const env: M6CandidateEnv = { ...setup.env, CASTLOOP_BUCKET: setup.bucket as never,
    CASTLOOP_VERSION_METADATA: { id: setup.versionId, tag: "", timestamp: "2026-10-02T12:00:00Z" },
    CASTLOOP_DLQ_NAME: setup.config.dlq_name, CASTLOOP_QUEUE: { send: async (body: unknown) => {
      const delivery = parseQueueDelivery(body);
      if (!delivery) throw new Error("Unexpected continuation delivery");
      queued.push(delivery.key);
    } } as never };
  const transport = async (input: URL, init: RequestInit) => fetchM6ManagementIntegration(
    new Request<unknown, IncomingRequestCfProperties>(new Request(input, init)), env, cachedAssets, { digest: publicationTestDigest });
  const inspector = new TargetInspectionClient(setup.config, "private-secret", transport);
  const stagingClient = new StagingAdminClient(setup.config, "private-secret", transport);
  const publicationClient = new PublicationAdminClient(setup.config, "private-secret", transport);
  const lifecycleClient = new LifecycleAdminClient(setup.config, "private-secret", transport);
  const rest = { accountId: setup.config.account_id, apiToken: "simulated-rest-token", transport: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const key = path.slice(path.indexOf("/objects/") + "/objects/".length);
    if (init?.method === "PUT") {
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      await setup.bucket.put(key, bytes);
      return Response.json({ success: true, result: { size: bytes.length } });
    }
    const object = await setup.bucket.get(key);
    return object ? new Response(new Uint8Array(object.bytes)) : new Response(null, { status: 404 });
  } };
  const consume = async (key: string) => {
    const deliver = async (next: string) => queueM6Candidate({ queue: setup.config.queue_name,
      messages: [{ id: crypto.randomUUID(), body: { object: { key: next } } }] } as never,
    env, cachedAssets, { digest: publicationTestDigest, maximumObjects: 2 });
    await deliver(key);
    let count = 1;
    while (queued.length) {
      if (++count > 100) throw new Error("Consumer continuation did not converge");
      await deliver(queued.shift()!);
    }
    return count;
  };
  const publicStatus = async (path: string, method = "GET") => (await fetchM6Candidate(
    new Request<unknown, IncomingRequestCfProperties>(`https://current.example${path}`, { method }), env, cachedAssets)).status;
  const lifecycle = async (kind: "show" | "episode", action: LifecycleOperationRequest["action"], episodeId?: string) => {
    const plan = await previewLocalM6Lifecycle(setup.config, { kind, show_id: "fresh", ...(episodeId ? { episode_id: episodeId } : {}) },
      action, "private-secret", { inspector, client: lifecycleClient });
    expect(plan.preview.eligible).toBe(true);
    expect(plan.preview.authorizes_operation).toBe(false);
    const state = await executeLocalM6Lifecycle(root, setup.config, plan,
      { operator_confirmed: true, request_sha256: await controlRequestHash(plan.request),
        ...(action === "delete" ? { irreversible_delete_acknowledged: true, retained_records_acknowledged: true } : {}) },
      "private-secret", lifecycleClient);
    const marker = state.commit_receipt!.key;
    const invocations = await consume(marker);
    const status = await lifecycleClient.status({ schema_version: 1, service_id: setup.config.service_id, action: "status", request: plan.request });
    expect(status.status?.state).toBe("completed");
    expect(status.ownership).toBe("released");
    expect(state.phase).toBe("committed");
    return invocations;
  };
  try {
    const registration = createShowRegistrationJournal(root, setup.config, { schema_version: 1, service_id: setup.config.service_id,
      show_id: "fresh", reservation_id: crypto.randomUUID(), action: "reserve" });
    await runShowRegistration(registration, createShowRegistrationEffects(setup.config, "private-secret", transport));
    const showFile = await createM6LocalShowDraft(root, setup.config, "fresh", "https://site.example/podcast");
    writeFileSync(join(root, "fresh", "cover.jpg"), Uint8Array.from([255, 216, 255, 2]));
    const showTarget = { kind: "show" as const, show_id: "fresh" };
    await updateLocalM6Draft(root, setup.config, showTarget, { asset: "show" }, "private-secret", { rest, client: stagingClient, inspector });
    expect((await readShowControl(env, "fresh"))!.value.lifecycle).toBe("draft");
    const showPublication = await publishLocalM6Draft(root, setup.config, showTarget, "private-secret", { inspector, client: publicationClient });
    await consume(publicationCommitKey(showPublication.publication.commit));
    expect((await readShowControl(env, "fresh"))!.value.lifecycle).toBe("active");
    expect(await publicStatus("/podcasts/fresh/feed.xml")).toBe(200);
    expect(readFileSync(showFile, "utf8")).toContain("https://site.example/podcast");
    const episodes: Array<{ id: string; metadataFile: string; mediaPath: string; revisionId: string; guid: string; publishedAt: string }> = [];
    for (const id of ["first", "second"]) {
      const metadataFile = await createM6LocalEpisodeDraft(root, setup.config, "fresh", id);
      const metadata = parseEpisodeDraft(readFileSync(metadataFile, "utf8"));
      const audioFile = join(root, "fresh", `${id}.mp3`);
      writeFileSync(audioFile, Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
      const target = { kind: "episode" as const, show_id: "fresh", episode_id: id };
      const audio = await updateLocalM6Draft(root, setup.config, target, { asset: "audio", audio_path: `${id}.mp3` },
        "private-secret", { rest, client: stagingClient, inspector });
      const stagedMetadata = await updateLocalM6Draft(root, setup.config, target, { asset: "episode_metadata" },
        "private-secret", { rest, client: stagingClient, inspector });
      expect(audio.upload.draft_job_id).toBe(stagedMetadata.upload.draft_job_id);
      const publication = await publishLocalM6Draft(root, setup.config, target, "private-secret",
        { inspector, client: publicationClient, audioPath: `${id}.mp3` });
      await consume(publicationCommitKey(publication.publication.commit));
      const revision = parseEpisodeRevision(setup.text(`public/episodes/fresh/${id}/metadata.toml`));
      expect(revision.guid).toBe(metadata.guid);
      expect(revision.published_at).toBe(metadata.published_at);
      episodes.push({ id, metadataFile, mediaPath: new URL(revision.enclosure_url).pathname, revisionId: revision.revision_id,
        guid: revision.guid, publishedAt: revision.published_at });
    }
    const first = episodes[0]!;
    const second = episodes[1]!;
    const changed = { ...parseEpisodeDraft(readFileSync(first.metadataFile, "utf8")), title: "Updated private Episode title" };
    writeFileSync(first.metadataFile, stringifyToml(changed));
    const target = { kind: "episode" as const, show_id: "fresh", episode_id: first.id };
    await updateLocalM6Draft(root, setup.config, target, { asset: "episode_metadata" }, "private-secret", { rest, client: stagingClient, inspector });
    const revisionPublication = await publishLocalM6Draft(root, setup.config, target, "private-secret", { inspector, client: publicationClient });
    await consume(publicationCommitKey(revisionPublication.publication.commit));
    expect(await setup.bucket.head(`public/episodes/fresh/${first.id}/revisions/${first.revisionId}.toml`)).not.toBeNull();
    const current = parseEpisodeRevision(setup.text(`public/episodes/fresh/${first.id}/metadata.toml`));
    expect(current.guid).toBe(first.guid);
    expect(current.published_at).toBe(first.publishedAt);
    expect(new URL(current.enclosure_url).pathname).toBe(first.mediaPath);
    const localBytes = readFileSync(first.metadataFile);

    await lifecycle("episode", "unpublish", first.id);
    expect(await publicStatus(first.mediaPath)).toBe(404);
    expect(await publicStatus(first.mediaPath, "HEAD")).toBe(404);
    expect(await publicStatus(second.mediaPath)).toBe(200);
    expect(setup.text("public/podcasts/fresh/feed.xml")).not.toContain(first.guid);
    expect(await setup.bucket.head(`public${first.mediaPath}`)).not.toBeNull();
    await lifecycle("episode", "restore", first.id);
    expect(await publicStatus(first.mediaPath)).toBe(200);
    expect(setup.text("public/podcasts/fresh/feed.xml")).toContain(first.guid);
    await lifecycle("show", "unpublish");
    for (const path of [first.mediaPath, second.mediaPath, "/podcasts/fresh/feed.xml", "/podcasts/fresh/cover.jpg"]) {
      expect(await publicStatus(path)).toBe(404);
      expect(await publicStatus(path, "HEAD")).toBe(404);
    }
    await lifecycle("show", "restore");
    expect(await publicStatus(first.mediaPath)).toBe(200);
    expect(await publicStatus("/podcasts/fresh/feed.xml")).toBe(200);
    expect(await lifecycle("episode", "delete", first.id)).toBeGreaterThan(1);
    expect(await publicStatus(first.mediaPath)).toBe(410);
    expect(await setup.bucket.head(`public${first.mediaPath}`)).toBeNull();
    expect((await readEpisodeLifecycle(env, "fresh", first.id))!.lifecycle).toBe("deleted");
    expect(await publicStatus(second.mediaPath)).toBe(200);
    expect(await lifecycle("show", "delete")).toBeGreaterThan(1);
    expect((await readShowControl(env, "fresh"))!.value.lifecycle).toBe("deleted");
    expect((await readEpisodeLifecycle(env, "fresh", second.id))!.lifecycle).toBe("deleted");
    expect(await publicStatus("/podcasts/fresh/feed.xml")).toBe(410);
    expect(await publicStatus(second.mediaPath)).toBe(410);
    expect(await setup.bucket.head(`public${second.mediaPath}`)).toBeNull();
    expect(await setup.bucket.head("system/shows/fresh/show.toml")).toBeNull();
    expect(await setup.bucket.head("system/show-reservations/fresh.json")).not.toBeNull();
    expect(readLocalDraft(root, setup.config, target).client_state?.phase).toBe("frozen");
    expect(readFileSync(first.metadataFile)).toEqual(localBytes);
    expect(registration.load().phase).toBe("registered");
    for (const [key, entry] of setup.entries) {
      if (key.startsWith("system/jobs/") || key.endsWith("/commit.json") || key.startsWith("system/show-publications/")) {
        const text = new TextDecoder().decode(entry.bytes);
        expect(text).not.toContain("Updated private Episode title");
        expect(text).not.toContain("private-secret");
      }
    }
    expect(purges.some((purge) => purge.showId === "fresh")).toBe(true);
    const before = [...setup.writes];
    await expect(updateLocalM6Draft(root, setup.config, showTarget, { asset: "show" }, "private-secret",
      { rest, client: stagingClient, inspector })).rejects.toThrow("blocks");
    expect(setup.writes).toEqual(before);
    expect((await readShowControl(env, "daily"))!.value.lifecycle).toBe("active");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

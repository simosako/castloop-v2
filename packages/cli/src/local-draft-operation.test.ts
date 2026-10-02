import { describe, expect, test } from "bun:test";
import { episodeDraftFromRevision, stageDraftPrefix, stringifyToml } from "@castloop/shared";
import { createLocalDraftJournal, readLocalDraft } from "./local-draft-journal";
import { runLocalDraftPublication, runLocalDraftStaging } from "./local-draft-operation";
import { PublicationAdminClient } from "./publication-client";
import { readLocalPublicationJob } from "./publication-journal";
import { StagingAdminClient } from "./staging-client";
import { readLocalStagingOperation } from "./staging-journal";
import { readShowControl } from "../../../src/lifecycle-control";
import { handleM6PublicationAdmin } from "../../../src/publication-admin";
import { handleM6StagingAdmin } from "../../../src/staging-admin";
import { stagingAdminFixture } from "../../../src/test-support/staging-admin";
import { publicationTestDigest } from "../../../src/test-support/episode-publication";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function fixture(mode: "show" | "initial" | "metadata" | "audio" = "show") {
  const episode = mode !== "show";
  const setup = await stagingAdminFixture(episode ? "audio" : "show");
  const base = mode === "metadata" || mode === "audio" ? await setup.addEpisode("next", "active") : undefined;
  const root = mkdtempSync("/tmp/opencode/castloop-draft-operation-");
  const directory = join(root, "daily");
  mkdirSync(directory);
  writeFileSync(join(directory, "show.toml"), setup.text("system/shows/daily/show.toml"));
  writeFileSync(join(directory, "cover.jpg"), Uint8Array.from([255, 216, 255, 2]));
  writeFileSync(join(directory, "episode-next.toml"), stringifyToml(base ?
    { ...episodeDraftFromRevision(base), ...(mode === "metadata" ? { title: "Changed local title" } : {}) } :
    { schema_version: 1, episode_id: "next", guid: crypto.randomUUID(), title: "Private title", description: "Private description",
      published_at: "2026-10-02T12:00:00Z" }));
  writeFileSync(join(directory, "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  const target = episode ? { kind: "episode" as const, show_id: "daily", episode_id: "next" } : { kind: "show" as const, show_id: "daily" };
  const id = setup.upload.draft_job_id;
  createLocalDraftJournal(root, setup.config, target, id, base?.revision_id);
  const file = join(root, ".castloop", "drafts", setup.config.service_id, episode ? "episode-daily--next.json" : "show-daily.json");
  const requests: string[] = [];
  let loseAction: string | undefined;
  let afterClaim: (() => void | Promise<void>) | undefined;
  const assertTargetLock = () => expect(readLocalDraft(root, setup.config, target).lock_present).toBe(true);
  const stagingClient = new StagingAdminClient(setup.config, "private-secret", async (input, init) => {
    assertTargetLock();
    const http = new Request(input, init);
    const action = (await http.clone().json() as { action: string }).action;
    requests.push(`stage:${action}`);
    const response = await handleM6StagingAdmin(http, setup.env, setup.bindings, { digest: publicationTestDigest });
    if (!response) throw new Error("Unexpected staging route");
    if (action === "claim") await afterClaim?.();
    if (loseAction === `stage:${action}`) throw new Error("Simulated lost acknowledgement");
    return response;
  });
  const publicationClient = new PublicationAdminClient(setup.config, "private-secret", async (input, init) => {
    assertTargetLock();
    const http = new Request(input, init);
    const action = (await http.clone().json() as { action: string }).action;
    requests.push(`publication:${action}`);
    const response = await handleM6PublicationAdmin(http, { ...setup.env, CASTLOOP_QUEUE: { send: async () => {} } }, setup.bindings);
    if (!response) throw new Error("Unexpected publication route");
    if (loseAction === `publication:${action}`) throw new Error("Simulated lost acknowledgement");
    return response;
  });
  const rest = { accountId: setup.config.account_id, apiToken: "test-rest-token", transport: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assertTargetLock();
    const method = init?.method;
    const path = new URL(String(input)).pathname;
    const key = path.slice(path.indexOf("/objects/") + "/objects/".length);
    requests.push(`rest:${method}`);
    if (method === "PUT") {
      const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
      await setup.bucket.put(key, body);
      if (loseAction === "rest:PUT") throw new Error("Simulated lost PUT acknowledgement after local IO settled");
      return Response.json({ success: true, result: { size: body.length } });
    }
    const object = await setup.bucket.get(key);
    if (!object) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(object.bytes));
  } };
  const header = async () => ({ schema_version: 1 as const, expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation,
    ...(episode ? { expected_episode_generation: 0 } : {}), created_at: "2026-10-02T12:00:00Z" });
  const upload = async (asset: "show" | "episode_metadata" | "audio", operationId = crypto.randomUUID()) =>
    runLocalDraftStaging(root, setup.config, target, { ...await header(), operation_id: operationId },
      asset === "audio" ? { asset, audio_path: "audio.mp3" } : { asset }, "private-secret", { rest, client: stagingClient });
  const publish = async () => runLocalDraftPublication(root, setup.config, target, { ...await header(), action: "publish" },
    { ...(base ? { baseRevision: base } : {}), ...(mode === "initial" || mode === "audio" ? { audioPath: "audio.mp3" } : {}) },
    "private-secret", publicationClient);
  return { ...setup, root, target, id, file, requests, upload, publish,
    lose: (action: string) => { loseAction = action; }, afterClaim: (effect: () => void | Promise<void>) => { afterClaim = effect; },
    dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("owned target-local staging and publication orchestration", () => {
  for (const mode of ["show", "initial", "metadata", "audio"] as const) {
    test(`${mode} uploads and explicitly publishes under one durable draft ID`, async () => {
      const setup = await fixture(mode);
      try {
        const assets = mode === "show" ? ["show"] as const : mode === "initial" ? ["audio", "episode_metadata"] as const :
          mode === "metadata" ? ["episode_metadata"] as const : ["audio"] as const;
        for (const asset of assets) {
          const uploaded = await setup.upload(asset);
          expect(uploaded.finish_receipt).toBe("staged");
          expect(uploaded.upload.draft_job_id).toBe(setup.id);
          expect(readLocalDraft(setup.root, setup.config, setup.target).client_state?.phase).toBe("editable");
          expect(await setup.bucket.head(`${stageDraftPrefix(uploaded.upload)}/commit.json`)).toBeNull();
        }
        const publication = await setup.publish();
        expect(publication.phase).toBe("committed");
        expect(readLocalDraft(setup.root, setup.config, setup.target).client_state?.phase).toBe("frozen");
        expect(readLocalDraft(setup.root, setup.config, setup.target).lock_present).toBe(false);
        const requests = [...setup.requests];
        await expect(setup.publish()).rejects.toThrow("frozen");
        await expect(setup.upload(assets[0])).rejects.toThrow("frozen");
        expect(setup.requests).toEqual(requests);
      } finally { setup.dispose(); }
    });
  }

  test("lost staging claim acknowledgement stays requested and blocks automatic replacement without more HTTP", async () => {
    const setup = await fixture();
    try {
      const operationId = crypto.randomUUID();
      setup.lose("stage:claim");
      await expect(setup.upload("show", operationId)).rejects.toThrow("outcome is unknown");
      expect(readLocalStagingOperation(setup.root, setup.config, operationId).client_state?.phase).toBe("claim_requested");
      expect(readLocalDraft(setup.root, setup.config, setup.target).client_state?.uploads[0]?.operation_id).toBe(operationId);
      const requests = [...setup.requests];
      await expect(setup.upload("show", operationId)).rejects.toThrow("unresolved");
      await expect(setup.upload("show")).rejects.toThrow("unresolved");
      await expect(setup.publish()).rejects.toThrow();
      expect(setup.requests).toEqual(requests);
    } finally { setup.dispose(); }
  });

  test("lost publication commit acknowledgement freezes edits but never promotes local completion or resends", async () => {
    const setup = await fixture();
    try {
      await setup.upload("show");
      setup.lose("publication:commit");
      await expect(setup.publish()).rejects.toThrow("outcome is unknown");
      expect(readLocalPublicationJob(setup.root, setup.config, setup.id).client_state?.phase).toBe("commit_requested");
      expect(readLocalDraft(setup.root, setup.config, setup.target).client_state?.phase).toBe("publication_prepared");
      const requests = [...setup.requests];
      await expect(setup.publish()).rejects.toThrow("requested");
      await expect(setup.upload("show")).rejects.toThrow("publication-prepared");
      expect(setup.requests).toEqual(requests);
    } finally { setup.dispose(); }
  });

  test("changed target record after claim prevents begin and PUT while retaining the acknowledged journal", async () => {
    const setup = await fixture();
    try {
      const operationId = crypto.randomUUID();
      setup.afterClaim(() => {
        const state = JSON.parse(readFileSync(setup.file, "utf8"));
        writeFileSync(setup.file, JSON.stringify({ ...state, uploads: [] }));
      });
      await expect(setup.upload("show", operationId)).rejects.toThrow("draft changed");
      expect(setup.requests).not.toContain("stage:begin");
      expect(setup.requests).not.toContain("rest:PUT");
      expect(readLocalStagingOperation(setup.root, setup.config, operationId).client_state?.phase).toBe("claimed");
    } finally { setup.dispose(); }
  });

  test("retained target lock and missing journal refuse before any HTTP or ID adoption", async () => {
    const setup = await fixture();
    try {
      writeFileSync(`${setup.file}.lock`, "retained");
      await expect(setup.upload("show")).rejects.toThrow("lock");
      await expect(setup.publish()).rejects.toThrow("lock");
      rmSync(`${setup.file}.lock`);
      rmSync(setup.file);
      await expect(setup.upload("show")).rejects.toThrow("existing");
      expect(setup.requests).toEqual([]);
    } finally { setup.dispose(); }
  });

  test("concurrent target operation is refused while the original claim is in flight", async () => {
    const setup = await fixture();
    try {
      setup.afterClaim(async () => { await expect(setup.upload("show")).rejects.toThrow("lock"); });
      expect((await setup.upload("show")).finish_receipt).toBe("staged");
      expect(setup.requests.filter((action) => action === "stage:claim")).toHaveLength(1);
    } finally { setup.dispose(); }
  });

  test("aborted settled PUT is retained and cannot publish, but an explicit new upload can replace it", async () => {
    const setup = await fixture();
    try {
      setup.lose("rest:PUT");
      const aborted = await setup.upload("show");
      expect(aborted.phase).toBe("finished");
      expect(aborted.finish_receipt).toBe("aborted");
      const requests = [...setup.requests];
      await expect(setup.publish()).rejects.toThrow("finished staged");
      expect(setup.requests).toEqual(requests);
      setup.lose("none");
      const replacement = await setup.upload("show");
      expect(replacement.finish_receipt).toBe("staged");
      expect(replacement.upload.draft_job_id).toBe(aborted.upload.draft_job_id);
      expect(readLocalStagingOperation(setup.root, setup.config, aborted.upload.operation_id).client_state?.finish_receipt).toBe("aborted");
    } finally { setup.dispose(); }
  });

  test("unresolved audio claim blocks the other Episode slot without more requests", async () => {
    const setup = await fixture("initial");
    try {
      setup.lose("stage:claim");
      await expect(setup.upload("audio")).rejects.toThrow("unknown");
      const requests = [...setup.requests];
      await expect(setup.upload("episode_metadata")).rejects.toThrow("unresolved");
      expect(setup.requests).toEqual(requests);
      expect(readLocalDraft(setup.root, setup.config, setup.target).client_state?.uploads).toHaveLength(1);
    } finally { setup.dispose(); }
  });
});

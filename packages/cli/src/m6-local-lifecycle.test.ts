import { expect, test } from "bun:test";
import { LifecycleAdminClient } from "./lifecycle-client";
import { readLocalLifecycleJob } from "./lifecycle-journal";
import { confirmLocalM6Lifecycle, executeLocalM6Lifecycle, prepareLocalM6Lifecycle, previewLocalM6Lifecycle, validateM6LifecyclePlan } from "./m6-local-lifecycle";
import { TargetInspectionClient } from "./target-inspection-client";
import { handleM6TargetInspection } from "../../../src/target-inspection-admin";
import { lifecycleAdminFixture } from "../../../src/test-support/lifecycle-admin";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

async function fixture() {
  const setup = await lifecycleAdminFixture();
  const root = mkdtempSync("/tmp/opencode/castloop-lifecycle-plan-");
  let requests = 0;
  const inspector = new TargetInspectionClient(setup.config, "private-secret", async (input, init) => {
    const response = await handleM6TargetInspection(new Request(input, init), setup.env, setup.bindings);
    if (!response) throw new Error("Unexpected inspection route");
    return response;
  });
  const client = new LifecycleAdminClient(setup.config, "private-secret", async (input, init) => {
    requests++;
    const body = await new Request(input, init).json();
    return setup.call(body);
  });
  const preview = (action: "unpublish" | "restore" | "delete" = "unpublish", showId = "daily") => previewLocalM6Lifecycle(
    setup.config, { kind: "show", show_id: showId }, action, "private-secret", { inspector, client, now: () => new Date("2026-10-02T12:00:00.987Z") });
  return { ...setup, root, inspector, client, preview, requestCount: () => requests,
    dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("lifecycle planning performs only bounded reads and dry-run, with a canonical fixed request for explicit confirmation", async () => {
  const setup = await fixture();
  try {
    const before = [...setup.entries];
    const writes = [...setup.writes];
    const plan = await setup.preview();
    expect(plan.request.created_at).toBe("2026-10-02T12:00:00Z");
    expect(plan.preview.request).toEqual(plan.request);
    expect(plan.preview.authorizes_operation).toBe(false);
    expect(plan.preview.eligible).toBe(true);
    expect(setup.writes).toEqual(writes);
    expect([...setup.entries]).toEqual(before);
    expect(existsSync(join(setup.root, ".castloop"))).toBe(false);
    expect(() => confirmLocalM6Lifecycle(plan.request.action, plan.preview.request_sha256, "")).toThrow("Explicit confirmation");
    const confirmation = confirmLocalM6Lifecycle(plan.request.action, plan.preview.request_sha256, "confirm");
    const journal = prepareLocalM6Lifecycle(setup.root, setup.config, plan, confirmation);
    expect(journal.load().phase).toBe("prepared");
    expect(journal.load().claim.request).toEqual(plan.request);
    expect(setup.requestCount()).toBe(1);
    expect(prepareLocalM6Lifecycle(setup.root, setup.config, plan, confirmation).load()).toEqual(journal.load());
    const file = join(setup.root, ".castloop", "lifecycle-jobs", setup.config.service_id, `${plan.request.job_id}.json`);
    expect(readFileSync(file, "utf8")).not.toContain("Private Episode description");
    expect(readFileSync(file, "utf8")).not.toContain("private-secret");
  } finally { setup.dispose(); }
});

test("deletion planning cannot become a journal without explicit irreversible and retained-record acknowledgements", async () => {
  const setup = await fixture();
  try {
    const plan = await setup.preview("delete");
    expect(() => confirmLocalM6Lifecycle("delete", plan.preview.request_sha256, "confirm")).toThrow("irreversible");
    expect(plan.preview.deletion_page?.authorizes_deletion).toBe(false);
    expect(() => prepareLocalM6Lifecycle(setup.root, setup.config, plan,
      { operator_confirmed: true, request_sha256: plan.preview.request_sha256 })).toThrow();
    expect(existsSync(join(setup.root, ".castloop"))).toBe(false);
    expect(() => prepareLocalM6Lifecycle(setup.root, setup.config, plan,
      { operator_confirmed: true, request_sha256: "0".repeat(64), irreversible_delete_acknowledged: true, retained_records_acknowledged: true })).toThrow();
    expect(existsSync(join(setup.root, ".castloop"))).toBe(false);
    const journal = prepareLocalM6Lifecycle(setup.root, setup.config, plan,
      confirmLocalM6Lifecycle("delete", plan.preview.request_sha256, "confirm-delete-retain-records"));
    expect(journal.load().phase).toBe("prepared");
    expect(setup.requestCount()).toBe(1);
  } finally { setup.dispose(); }
});

test("missing or ineligible targets produce blockers but never local or remote operation records", async () => {
  const setup = await fixture();
  try {
    for (const plan of [await setup.preview("restore"), await setup.preview("delete", "missing")]) {
      expect(plan.preview.eligible).toBe(false);
      expect(() => prepareLocalM6Lifecycle(setup.root, setup.config, plan,
        { operator_confirmed: true, request_sha256: plan.preview.request_sha256,
          irreversible_delete_acknowledged: true, retained_records_acknowledged: true })).toThrow("blockers");
    }
    expect(existsSync(join(setup.root, ".castloop"))).toBe(false);
  } finally { setup.dispose(); }
});

test("plan service, request, hash and strict schema cannot be changed after preview", async () => {
  const setup = await fixture();
  try {
    const plan = await setup.preview();
    for (const invalid of [{ ...plan, title: "private" }, { ...plan, request: { ...plan.request, job_id: crypto.randomUUID() } },
      { ...plan, preview: { ...plan.preview, request_sha256: "0".repeat(64) } },
      { ...plan, preview: { ...plan.preview, service_id: "other" } }]) {
      expect(() => validateM6LifecyclePlan(setup.config, invalid)).toThrow();
    }
    expect(existsSync(join(setup.root, ".castloop"))).toBe(false);
  } finally { setup.dispose(); }
});

test("lost claim acknowledgement remains requested and cannot be replayed from the same approved plan", async () => {
  const setup = await fixture();
  try {
    const plan = await setup.preview();
    const confirmation = { operator_confirmed: true as const, request_sha256: plan.preview.request_sha256 };
    const client = { claim: async (input: Parameters<typeof setup.client.claim>[0]) => { await setup.client.claim(input); throw new Error("Lost receipt"); },
      commit: (input: Parameters<typeof setup.client.commit>[0]) => setup.client.commit(input),
      status: (input: Parameters<typeof setup.client.status>[0]) => setup.client.status(input),
      retry: (input: Parameters<typeof setup.client.retry>[0]) => setup.client.retry(input) };
    await expect(executeLocalM6Lifecycle(setup.root, setup.config, plan, confirmation, "private-secret", client)).rejects.toThrow("Lost receipt");
    expect(readLocalLifecycleJob(setup.root, setup.config, plan.request.job_id).client_state?.phase).toBe("claim_requested");
    const requests = setup.requestCount();
    await expect(executeLocalM6Lifecycle(setup.root, setup.config, plan, confirmation, "private-secret", client)).rejects.toThrow("requested");
    expect(setup.requestCount()).toBe(requests);
  } finally { setup.dispose(); }
});

test("a stale approved preview still fails server admission rather than silently changing its generation", async () => {
  const setup = await fixture();
  try {
    const plan = await setup.preview();
    await setup.execute(await setup.operationRequest("show", "unpublish"));
    await expect(executeLocalM6Lifecycle(setup.root, setup.config, plan,
      { operator_confirmed: true, request_sha256: plan.preview.request_sha256 }, "private-secret", setup.client)).rejects.toThrow("not verified");
    const state = readLocalLifecycleJob(setup.root, setup.config, plan.request.job_id).client_state!;
    expect(state.phase).toBe("claim_requested");
    expect(state.claim.request.expected_show_generation).toBe(plan.request.expected_show_generation);
  } finally { setup.dispose(); }
});

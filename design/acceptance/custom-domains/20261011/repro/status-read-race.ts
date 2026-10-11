import { publicationAdminFixture } from "../../../../../src/test-support/publication-admin";
import { inspectPublication } from "../../../../../src/publication-inspection";
import { PublicationAdminClient } from "../../../../../packages/cli/src/publication-client";
import { readRemoteOperationStatus } from "../../../../../packages/cli/src/remote-operation-status";
import { createPublicationJournal } from "../../../../../packages/cli/src/publication-journal";
import { mkdtempSync } from "node:fs";

const setup = await publicationAdminFixture();
await setup.publicationSuccess(setup.body("claim"));
const root = mkdtempSync("/tmp/opencode/status-read-race-");
createPublicationJournal(root, setup.config, setup.frozen);
const key = `system/jobs/${setup.frozen.request.job_id}/publication.json`;
const original = setup.text(key);
const head = setup.bucket.head.bind(setup.bucket);
const output: Record<string, unknown> = { local_only: true, cloudflare_requests: 0 };

output.stable_before = (await inspectPublication(setup.env, "service", setup.frozen)).result;
setup.bucket.head = async (name) => {
  if (name === key) await setup.bucket.put(key, original);
  return head(name);
};
try {
  await inspectPublication(setup.env, "service", setup.frozen);
  throw new Error("Expected snapshot race rejection");
} catch (error) {
  output.worker_internal_error = (error as Error).message;
}
const transport = async (_url: URL, init: RequestInit) => {
  const response = await setup.call(JSON.parse(init.body as string));
  const payload = await response.clone().json();
  output.http_status = response.status;
  output.reason_code = (payload as { reason_code?: string }).reason_code;
  return response;
};
try {
  await new PublicationAdminClient(setup.config, "private-secret", transport).status(setup.frozen);
} catch (error) {
  output.client_error = (error as Error).message;
}
try {
  await readRemoteOperationStatus(root, setup.config, "publication", setup.frozen.request.job_id,
    () => "private-secret", transport);
} catch (error) {
  output.cli_error = (error as Error).message;
}
setup.bucket.head = head;
output.stable_after = (await inspectPublication(setup.env, "service", setup.frozen)).result;
console.log(JSON.stringify(output, null, 2));

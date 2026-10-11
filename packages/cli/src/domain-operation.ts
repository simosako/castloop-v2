import { domainOperationRequestSchema, m6ServiceConfigHash, normalizeHostname, serviceManagementBaseUrl } from "@castloop/shared";
import type { DomainAdminRequest, DomainAdminResponse, DomainOperationRequest, ServiceConfig } from "@castloop/shared";
import { administratorKey } from "./administrator-key";
import { CloudflareApi } from "./cloudflare-api";
import type { WorkerDomain } from "./cloudflare-api";
import { DomainClient } from "./domain-client";
import { createDomainJournal, domainTargetConfig, readLocalDomainChanges, synchronizeDomainConfig } from "./domain-journal";
import type { DomainJournal } from "./domain-journal";
import { M6AdminOperationRejected } from "./m6-admin-json";

export type DomainEffects = {
  admin: (input: DomainAdminRequest) => Promise<DomainAdminResponse>;
  domains: (workerName: string) => Promise<WorkerDomain[]>;
  attach: (hostname: string, workerName: string, beforeMutation: () => Promise<void>) => Promise<WorkerDomain>;
  detach: (hostname: string, workerName: string, domainId: string) => Promise<void>;
  verifyOrigin: (origin: string, workerVersionId: string) => Promise<void>;
};

function matchingDomain(domains: WorkerDomain[], request: DomainOperationRequest, workerName: string): WorkerDomain {
  if (domains.length !== 1 || domains[0]!.hostname !== request.domain_change.hostname || domains[0]!.service !== workerName ||
    !domains[0]!.id || !domains[0]!.zone_id) throw new Error("Custom Domain connection differs from its frozen hostname or Worker");
  return domains[0]!;
}

function settled(response: DomainAdminResponse, request: DomainOperationRequest): void {
  if (response.admission.state !== "paused" || response.admission.pause_id !== request.pause_id || response.admission.invocations.length ||
    response.admission.url_change?.operation_id !== request.operation_id || response.admission.url_change.execution_id) {
    throw new Error("Domain operation retains an active or unknown owner/token; do not release or replay it");
  }
}

async function run(journal: DomainJournal, root: string, effects: DomainEffects): Promise<void> {
  const request = journal.load().request;
  const workerName = journal.load().config.worker_name;
  const observe = () => effects.admin({ action: "status", request });
  const saveResponse = (response: DomainAdminResponse, pending?: { action: "claim-connection"; execution_id: string }) => {
    const { pending: _pending, ...state } = journal.load();
    journal.save({ ...state, ...(response.progress ? { progress: response.progress } : {}), ...(pending ? { pending } : {}) });
  };
  const mutate = async (input: Exclude<DomainAdminRequest, { action: "inspect" }>) => {
    if (input.action === "status") throw new Error("Read-only domain status must not create a mutation journal");
    const execution = input.action === "claim-connection" ? input.execution_id : input.action === "return-connection" ? input.receipt.execution_id : undefined;
    journal.save({ ...journal.load(), pending: { action: input.action,
      ...(execution ? { execution_id: execution } : {}) } });
    let response: DomainAdminResponse;
    try { response = await effects.admin(input); }
    catch (error) {
      if (error instanceof M6AdminOperationRejected && input.action !== "claim-connection" && input.action !== "return-connection") {
        const { pending: _pending, ...state } = journal.load();
        journal.save(state);
      }
      throw error;
    }
    saveResponse(response, input.action === "claim-connection" ? { action: "claim-connection", execution_id: input.execution_id } : undefined);
    return response;
  };

  let response = await observe();
  const pending = journal.load().pending;
  if (pending) {
    if (pending.action === "connection") throw new Error("Cloudflare mutation outcome is unknown; retain its connection token without replay or release");
    if (pending.action === "return-connection" && journal.load().connection_receipt) {
      response = await mutate({ action: "return-connection", request, receipt: journal.load().connection_receipt! });
    } else if (pending.action === "claim-connection" && response.admission.url_change?.execution_id === pending.execution_id &&
      response.admission.url_change?.execution_kind === "connection") {
      saveResponse(response, { action: "claim-connection", execution_id: pending.execution_id! });
    } else if (pending.action === "complete" && response.progress?.phase === "complete" && !response.admission.url_change &&
      response.service_config_sha256 === request.target_service_config_sha256) {
      saveResponse(response);
    } else if (["begin", "step"].includes(pending.action) && response.progress && !response.admission.url_change?.execution_id &&
      response.admission.url_change?.operation_id === request.operation_id && (pending.action === "begin" ||
        JSON.stringify(response.progress) !== JSON.stringify(journal.load().progress))) {
      saveResponse(response);
    } else throw new Error("Domain request outcome is not settled by retained progress; preserve it without replay");
  }

  if (response.progress?.phase === "complete" && !response.admission.url_change) {
    if (response.service_config_sha256 !== request.target_service_config_sha256 || response.admission.state !== "paused" ||
      response.admission.pause_id !== request.pause_id || response.admission.invocations.length) {
      throw new Error("Completed domain settings or pause changed; do not restore historical settings");
    }
    if (journal.load().completed) return;
    if (!journal.load().connection_receipt && response.progress.connection_receipt) {
      journal.save({ ...journal.load(), connection_receipt: response.progress.connection_receipt });
    }
    await synchronizeDomainConfig(root, journal.load());
    journal.save({ ...journal.load(), progress: response.progress, completed: true });
    return;
  }
  if (!response.progress || !response.admission.url_change) {
    if (response.progress?.phase !== undefined && response.progress.phase !== "feeds") throw new Error("Do not recreate an advanced domain owner");
    response = await mutate({ action: "begin", request });
  }
  const connect = async (): Promise<void> => {
    let receipt = journal.load().connection_receipt ?? response.progress?.connection_receipt;
    if (!receipt) {
      const pendingClaim = journal.load().pending;
      const token = pendingClaim?.action === "claim-connection" ? pendingClaim.execution_id : crypto.randomUUID();
      if (!token) throw new Error("Domain connection has no owned token");
      const claim = async () => {
        if (response.admission.url_change?.execution_id !== token) response = await mutate({ action: "claim-connection", request, execution_id: token });
        if (response.admission.url_change?.execution_id !== token || response.admission.url_change.execution_kind !== "connection") {
          throw new Error("Domain connection claim was not confirmed");
        }
        journal.save({ ...journal.load(), pending: { action: "connection", execution_id: token } });
      };
      let domainId: string;
      if (request.domain_change.action === "add") {
        const domain = await effects.attach(request.domain_change.hostname, workerName, claim);
        domainId = matchingDomain([domain], request, workerName).id;
      } else {
        const domain = matchingDomain(await effects.domains(workerName), request, workerName);
        domainId = domain.id;
        await claim();
        await effects.detach(request.domain_change.hostname, workerName, domainId);
      }
      receipt = { action: request.domain_change.action, execution_id: token, domain_id: domainId };
      const { pending: _pending, ...state } = journal.load();
      journal.save({ ...state, connection_receipt: receipt });
    } else if (!journal.load().connection_receipt) journal.save({ ...journal.load(), connection_receipt: receipt });
    response = await mutate({ action: "return-connection", request, receipt });
    settled(response, request);
  };
  if (request.domain_change.action === "add") {
    if (!response.progress?.connection_receipt) await connect();
    settled(response, request);
    const domain = matchingDomain(await effects.domains(workerName), request, workerName);
    if (domain.id !== journal.load().connection_receipt?.domain_id) throw new Error("Attached domain identity changed");
    await effects.verifyOrigin(request.public_base_url, request.worker_version_id);
  }
  if (response.progress?.phase === "feeds") settled(response, request);
  for (let step = 0; response.progress?.phase === "feeds"; step++) {
    if (step > 100) throw new Error("Domain feed steps exceed the existing 100-Show budget; keep the service paused");
    response = await mutate({ action: "step", request });
    settled(response, request);
  }
  if (response.service_config_sha256 !== request.target_service_config_sha256) throw new Error("Remote domain settings did not reach the frozen target");
  await synchronizeDomainConfig(root, journal.load());
  await effects.verifyOrigin(request.workers_dev_base_url, request.worker_version_id);
  if (request.domain_change.action === "remove" && !response.progress?.connection_receipt) await connect();
  settled(response, request);
  const domains = await effects.domains(workerName);
  if (request.domain_change.action === "add") {
    if (matchingDomain(domains, request, workerName).id !== journal.load().connection_receipt?.domain_id) throw new Error("Domain identity changed before completion");
  } else if (domains.length) throw new Error("Domain detach did not converge; keep its owner");
  response = await mutate({ action: "complete", request });
  if (response.progress?.phase !== "complete" || response.admission.url_change || response.admission.state !== "paused" ||
    response.admission.pause_id !== request.pause_id || response.admission.invocations.length ||
    response.service_config_sha256 !== request.target_service_config_sha256) throw new Error("Domain completion did not confirm paused settings and released ownership");
  journal.save({ ...journal.load(), completed: true });
}

export async function runDomainCommand(root: string, config: ServiceConfig, action: "add" | "list" | "remove", hostname?: string,
  operationId?: string, injected?: DomainEffects): Promise<unknown> {
  if (action === "add") hostname = normalizeHostname(hostname ?? "");
  if (operationId !== undefined) domainOperationRequestSchema.shape.operation_id.parse(operationId);
  const retained = readLocalDomainChanges(root, config);
  const effects = injected ?? (() => {
    const client = new DomainClient(config, administratorKey(root));
    const api = new CloudflareApi(config);
    return { admin: (input: DomainAdminRequest) => client.call(input), domains: (workerName: string) => api.workerDomains("service", workerName),
      attach: (host: string, worker: string, claim: () => Promise<void>) => api.ensureWorkerDomain(host, worker, claim),
      detach: (host: string, worker: string, id: string) => api.removeWorkerDomain(host, worker, id),
      verifyOrigin: (origin: string, version: string) => client.verifyOrigin(origin, version) };
  })();
  if (action === "list") {
    const remote = await effects.admin({ action: "inspect", service_id: config.service_id });
    const domains = await effects.domains(config.worker_name);
    const expectedHost = new URL(remote.public_base_url).origin === remote.workers_dev_base_url ? undefined : new URL(remote.public_base_url).hostname;
    return { result: "domains", public_base_url: remote.public_base_url, workers_dev_base_url: remote.workers_dev_base_url,
      configuration_matches: await m6ServiceConfigHash(config) === remote.service_config_sha256,
      connections_match: expectedHost ? domains.length === 1 && domains[0]!.hostname === expectedHost && domains[0]!.service === config.worker_name : domains.length === 0,
      domains, admission: remote.admission, local_operations: retained.filter((entry) => !entry.state.completed || entry.lock_present)
        .map((entry) => ({ operation_id: entry.state.request.operation_id, domain_change: entry.state.request.domain_change,
          pending: entry.state.pending, phase: entry.state.progress?.phase ?? "prepared", lock_present: entry.lock_present })) };
  }
  const unfinished = retained.filter((entry) => !entry.state.completed || entry.lock_present);
  const chosen = operationId ? retained.find((entry) => entry.state.request.operation_id === operationId) : unfinished[0];
  if (unfinished.length > 1 || chosen?.lock_present || chosen && chosen.state.request.domain_change.action !== action ||
    chosen && hostname !== undefined && chosen.state.request.domain_change.hostname !== hostname ||
    operationId && unfinished.length && unfinished[0]!.state.request.operation_id !== operationId) {
    throw new Error("Preserve the unfinished domain operation or unknown client lock; do not start a different request");
  }
  let journal: DomainJournal;
  if (chosen) {
    if (![chosen.state.request.service_config_sha256, chosen.state.request.target_service_config_sha256].includes(await m6ServiceConfigHash(config))) {
      throw new Error("Local settings differ from the retained domain request");
    }
    journal = createDomainJournal(root, chosen.state.config, chosen.state.request);
  } else {
    const remote = await effects.admin({ action: "inspect", service_id: config.service_id });
    const management = serviceManagementBaseUrl(config);
    if (remote.admission.state !== "paused" || remote.admission.invocations.length || remote.admission.url_change ||
      await m6ServiceConfigHash(config) !== remote.service_config_sha256) throw new Error("Explicitly pause, drain and synchronize before a new domain operation");
    const domains = await effects.domains(config.worker_name);
    if (action === "add" && (new URL(config.public_base_url).origin !== management || domains.length) ||
      action === "remove" && new URL(config.public_base_url).origin === management) throw new Error("Add requires no custom domain; remove requires its configured custom domain");
    if (action === "remove") hostname = new URL(config.public_base_url).hostname;
    const request = domainOperationRequestSchema.parse({ operation_id: operationId ?? crypto.randomUUID(), service_id: config.service_id,
      expected_service_generation: remote.admission.generation, pause_id: remote.admission.pause_id, worker_version_id: remote.worker_version_id,
      service_config_sha256: remote.service_config_sha256, public_base_url: action === "add" ? `https://${hostname}` : management,
      workers_dev_base_url: management, domain_change: { action, hostname }, target_service_config_sha256: "0".repeat(64) });
    if (action === "remove") matchingDomain(domains, request, config.worker_name);
    request.target_service_config_sha256 = await m6ServiceConfigHash(domainTargetConfig({ config, request }));
    journal = createDomainJournal(root, config, request);
  }
  try { await journal.exclusively(() => run(journal, root, effects)); }
  catch (error) { throw new Error(`Domain operation ${journal.load().request.operation_id}: ${error instanceof Error ? error.message : "blocked"}`); }
  return { result: "domain-changed-paused", operation_id: journal.load().request.operation_id,
    public_base_url: journal.load().request.public_base_url, pause_id: journal.load().request.pause_id };
}

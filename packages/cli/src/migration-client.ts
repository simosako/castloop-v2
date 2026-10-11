import { migrationAdminStatusSchema, migrationBootstrapRequestSchema, migrationDeploymentSettlementSchema,
  serviceConfigSchema, serviceManagementBaseUrl, migrationBridgeDeploymentEvidenceSchema, migrationQuiescenceSchema, serviceMigrationRequestSchema,
  migrationServiceIdentitySchema, migrationPauseRequestSchema, migrationOperationIdentitySchema,
  migrationInitializationRequestSchema, migrationInitializationResultSchema, migrationActionResponseSchema } from "@castloop/shared";
import type { MigrationAdminStatus, MigrationBootstrapRequest, MigrationBridgeDeploymentEvidence, MigrationQuiescence,
  MigrationInitializationResult, ServiceConfig, ServiceMigrationRequest } from "@castloop/shared";

export class MigrationAdminClient {
  private readonly config: ServiceConfig;
  private readonly managementBaseUrl: string;
  private readonly adminKey: string;
  private readonly transport: typeof fetch;

  constructor(config: ServiceConfig, adminKey: string, transport: typeof fetch = fetch) {
    this.config = serviceConfigSchema.parse(config);
    this.managementBaseUrl = serviceManagementBaseUrl(this.config);
    if (!adminKey) throw new Error("Migration administration requires the local administrator key");
    this.adminKey = adminKey;
    this.transport = transport;
  }

  private async call(route: string, input?: object): Promise<unknown> {
    const response = await this.transport(new URL(`/admin/migration/${route}`, this.managementBaseUrl), {
      method: input ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(120000),
      headers: { "X-Castloop-Key": this.adminKey, "User-Agent": "castloop-cli/0.1",
        ...(input ? { "Content-Type": "application/json" } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    if (response.status !== 200) {
      if (response.body) await response.body.cancel();
      throw new Error(`Migration ${route} failed (HTTP ${response.status}); inspect retained admission/progress before retrying`);
    }
    if (response.headers.get("Cache-Control") !== "no-store") {
      if (response.body) await response.body.cancel();
      throw new Error("Migration administrator response is not explicitly non-cacheable");
    }
    if (!response.body) throw new Error("Migration response body is missing");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    let text = "";
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > 65536) { await reader.cancel(); throw new Error("Migration response exceeds its record budget"); }
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    return JSON.parse(text) as unknown;
  }

  async status(): Promise<MigrationAdminStatus> {
    const value = migrationAdminStatusSchema.parse(await this.call("status"));
    if (value.service_id !== this.config.service_id || value.account_id !== this.config.account_id || value.worker_name !== this.config.worker_name) {
      throw new Error("Migration status belongs to another service/account/Worker");
    }
    return value;
  }

  private async bridgeCall(bridgeInput: MigrationBridgeDeploymentEvidence, route: string, input: { service_id: string }): Promise<unknown> {
    const bridge = migrationBridgeDeploymentEvidenceSchema.parse(bridgeInput);
    if (input.service_id !== this.config.service_id || bridge.service_id !== this.config.service_id ||
      bridge.account_id !== this.config.account_id || bridge.worker_name !== this.config.worker_name) throw new Error("Bridge operation belongs to another service/account/Worker");
    const status = await this.status();
    if (status.worker_protocol !== "legacy_fenced" || status.worker_bridge_id !== bridge.bridge_id ||
      status.worker_version_id !== bridge.worker_version_id || status.admission && status.admission.mode !== "legacy" ||
      status.admission?.migration?.execution_id) throw new Error("Bridge operation requires its expected executing version/tag without an unknown active migration token");
    return this.call(route, input);
  }

  private async bridgeResult(bridge: MigrationBridgeDeploymentEvidence, route: string, input: { service_id: string },
    expected: "initialized" | "paused" | "resumed" | "claimed" | "confirmed"): Promise<void> {
    const response = migrationActionResponseSchema.parse(await this.bridgeCall(bridge, route, input));
    if (response.result !== expected) throw new Error("Bridge operation returned an unexpected result; inspect retained state without automatic retry");
  }

  async initializeAdmission(bridge: MigrationBridgeDeploymentEvidence): Promise<void> {
    await this.bridgeResult(bridge, "initialize-admission", migrationServiceIdentitySchema.parse({ schema_version: 1,
      service_id: this.config.service_id }), "initialized");
  }

  async pauseAdmission(bridge: MigrationBridgeDeploymentEvidence, pauseId: string): Promise<void> {
    await this.bridgeResult(bridge, "pause", migrationPauseRequestSchema.parse({ schema_version: 1,
      service_id: this.config.service_id, pause_id: pauseId }), "paused");
  }

  async claimMigration(bridge: MigrationBridgeDeploymentEvidence, input: ServiceMigrationRequest): Promise<void> {
    await this.bridgeResult(bridge, "claim", serviceMigrationRequestSchema.parse(input), "claimed");
  }

  async confirmQuiescence(bridgeInput: MigrationBridgeDeploymentEvidence, input: MigrationQuiescence): Promise<void> {
    const bridge = migrationBridgeDeploymentEvidenceSchema.parse(bridgeInput);
    const confirmation = migrationQuiescenceSchema.parse(input);
    if (confirmation.bridge_worker_version_id !== bridge.worker_version_id) throw new Error("Quiescence confirmation belongs to another bridge version");
    await this.bridgeResult(bridge, "quiescence", confirmation, "confirmed");
  }

  async initializeMigrationStep(bridge: MigrationBridgeDeploymentEvidence, migrationId: string, maximumTargets = 20): Promise<MigrationInitializationResult> {
    const input = migrationInitializationRequestSchema.parse({ schema_version: 1, service_id: this.config.service_id,
      migration_id: migrationId, maximum_targets: maximumTargets });
    return migrationInitializationResultSchema.parse(await this.bridgeCall(bridge, "apply", input));
  }

  async abortUnstartedMigration(bridge: MigrationBridgeDeploymentEvidence, migrationId: string): Promise<void> {
    await this.bridgeResult(bridge, "abort-unstarted", migrationOperationIdentitySchema.parse({ schema_version: 1,
      service_id: this.config.service_id, migration_id: migrationId }), "paused");
  }

  async resumeLegacyAdmission(bridge: MigrationBridgeDeploymentEvidence, pauseId: string): Promise<void> {
    await this.bridgeResult(bridge, "resume-legacy", migrationPauseRequestSchema.parse({ schema_version: 1,
      service_id: this.config.service_id, pause_id: pauseId }), "resumed");
  }

  async prepareDeployment(input: MigrationBootstrapRequest): Promise<void> {
    const request = migrationBootstrapRequestSchema.parse(input);
    if (request.service_id !== this.config.service_id) throw new Error("Bootstrap request belongs to another service");
    const response = await this.call("prepare-deployment", request);
    if (!response || typeof response !== "object" || !("result" in response) || response.result !== "prepared") throw new Error("Invalid bootstrap preparation response");
  }

  async beginDeployment(input: MigrationBootstrapRequest): Promise<{ bootstrap_id: string; start_allowed: true }> {
    const request = migrationBootstrapRequestSchema.parse(input);
    if (request.service_id !== this.config.service_id) throw new Error("Bootstrap request belongs to another service");
    const response = await this.call("begin-deployment", { schema_version: 1, service_id: request.service_id,
      migration_id: request.migration_id, bootstrap_id: request.bootstrap_id });
    if (!response || typeof response !== "object" || !("start_allowed" in response) || response.start_allowed !== true ||
      !("bootstrap_id" in response) || response.bootstrap_id !== request.bootstrap_id || Object.keys(response).length !== 2) {
      throw new Error("Bootstrap start authorization does not match this frozen request");
    }
    return { bootstrap_id: request.bootstrap_id, start_allowed: true };
  }

  async settleDeployment(input: MigrationBootstrapRequest, evidence: unknown): Promise<void> {
    const request = migrationBootstrapRequestSchema.parse(input);
    const settlement = migrationDeploymentSettlementSchema.parse(evidence);
    if (request.service_id !== this.config.service_id || settlement.bootstrap_id !== request.bootstrap_id ||
      settlement.deployment.service_id !== this.config.service_id || settlement.deployment.account_id !== this.config.account_id ||
      settlement.deployment.worker_name !== this.config.worker_name) throw new Error("Bootstrap settlement belongs to another service or request");
    const response = await this.call("settle-deployment", { schema_version: 1, service_id: request.service_id,
      migration_id: request.migration_id, settlement });
    if (!response || typeof response !== "object" || !("result" in response) || response.result !== "verifying") throw new Error("Invalid bootstrap settlement response");
  }
}

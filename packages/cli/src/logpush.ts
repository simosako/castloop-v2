import { sqliteAccessStatsSourceSchema } from "../../shared/src/sqlite-access-stats";
import type { SqliteAccessStatsSource } from "../../shared/src/sqlite-access-stats";
import { sqliteDomainHostnameSchema } from "../../shared/src/sqlite-domain";
import { sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { administratorKey } from "./administrator-key";
import { LogpushCloudflare } from "./logpush-cloudflare";
import type { LogpushJob } from "./logpush-cloudflare";
import { LOGPUSH_RETENTION_DAYS, logpushConfigurationSchema, logpushConfigurationStorage, logpushFilter,
  logpushTokenName, logpushZoneIdSchema, readLogpushConfiguration } from "./logpush-config";
import type { LogpushConfiguration, LogpushZone } from "./logpush-config";
import type { R2RestOptions } from "./bounded-http-read";
import { SqliteServiceClient } from "./sqlite-service-client";
import { protectLocalState } from "./workspace-protection";

export type LogpushCommandOptions = { zoneId?: string; bucketName?: string };

function newSource(zoneId: string, host: string, now: number): SqliteAccessStatsSource {
  return { source_id: `http_logpush:${zoneId}:${host}`, collector: "http_logpush", zone_id: zoneId, host,
    metric_definition: "access-daily-v1", byte_measurement: "edge_body", collection_mode: "best_effort",
    collection_started_at_ms: now, collection_ended_at_ms: null, last_complete_at_ms: null,
    interruptions: [{ started_at_ms: now, ended_at_ms: null, reason_code: "job_disabled" }] };
}
function observeSources(zone: LogpushZone, job: LogpushJob, now: number): SqliteAccessStatsSource[] {
  return zone.sources.map((source) => {
    const interruptions = source.interruptions.map((entry) => ({ ...entry }));
    if (!job.enabled && !interruptions.some((entry) => entry.reason_code === "job_disabled" && entry.ended_at_ms === null)) {
      interruptions.push({ started_at_ms: now, ended_at_ms: null, reason_code: "job_disabled" });
    }
    for (const entry of interruptions) {
      if (entry.ended_at_ms === null && entry.reason_code === "job_disabled" && job.enabled && now > entry.started_at_ms) entry.ended_at_ms = now;
      if (entry.ended_at_ms === null && entry.reason_code === "delivery_error" && (job.last_complete ?? 0) > entry.started_at_ms) entry.ended_at_ms = job.last_complete;
    }
    if (job.last_error !== null && job.last_error >= source.collection_started_at_ms &&
      !interruptions.some((entry) => entry.reason_code === "delivery_error" && entry.started_at_ms === job.last_error)) {
      interruptions.push({ started_at_ms: job.last_error,
        ended_at_ms: (job.last_complete ?? 0) > job.last_error ? job.last_complete : null, reason_code: "delivery_error" });
    }
    return sqliteAccessStatsSourceSchema.parse({ ...source, interruptions,
      last_complete_at_ms: job.last_complete === null ? source.last_complete_at_ms : Math.max(source.last_complete_at_ms ?? 0, job.last_complete) });
  });
}

export async function runLogpushCommand(root: string, config: SqliteServiceConfig, action: string,
  selected: LogpushCommandOptions, options: R2RestOptions): Promise<unknown> {
  if (!["setup", "status", "enable", "disable"].includes(action) || !selected.zoneId ||
    (action === "setup" ? !selected.bucketName : selected.bucketName !== undefined)) {
    throw new Error("Expected logpush setup --zone-id ID --bucket-name NAME, or status|enable|disable --zone-id ID");
  }
  const zoneId = logpushZoneIdSchema.parse(selected.zoneId);
  const bucketName = selected.bucketName === undefined ? undefined : sqliteServiceConfigSchema.shape.bucket_name.parse(selected.bucketName);
  if (bucketName === config.bucket_name) throw new Error("Logpush requires a separate private bucket, not the media originals bucket");
  const host = action === "setup" ? sqliteDomainHostnameSchema.parse(new URL(config.public_base_url).hostname) : undefined;
  if (action === "setup" && config.public_base_url === config.workers_dev_base_url) throw new Error("HTTP Requests Logpush setup requires the service's custom domain");
  let state = readLogpushConfiguration(root, config);
  if (state && bucketName !== undefined && state.bucket_name !== bucketName) throw new Error("Keep the saved Logpush bucket; bucket migration is not supported");
  let zone = state?.zones.find((entry) => entry.zone_id === zoneId);
  if (action !== "setup" && !zone) throw new Error("No saved Logpush configuration for this zone; run setup first");
  const api = new LogpushCloudflare(config, options);
  const health = await new SqliteServiceClient(config, administratorKey(root), options.transport).health();
  if (action !== "status" && !health.publication_ready) throw new Error("Logpush changes require a ready service outside domain maintenance");
  if (action === "setup") {
    const hosts = [...new Set([...(zone?.settings.hosts ?? []), host!])].sort();
    logpushFilter(hosts);
    await api.preflight(zoneId, hosts);
    const now = Date.now();
    if (!state) {
      if (await api.bucket(bucketName!) !== null) throw new Error("Logpush setup cannot adopt an existing or unknown bucket");
      state = logpushConfigurationSchema.parse({ schema_version: 1, service_id: config.service_id,
        account_id: config.account_id, worker_name: config.worker_name, workers_dev_base_url: config.workers_dev_base_url,
        origin_bucket_name: config.bucket_name, bucket_name: bucketName, created_at_ms: now, zones: [] });
    }
    if (!zone) zone = { zone_id: zoneId, operation_id: crypto.randomUUID(), settings: { hosts, enabled: true },
      previous_settings: null, job_id: null, token_id: null, sources: hosts.map((host) => newSource(zoneId, host, now)) };
    else if (JSON.stringify(hosts) !== JSON.stringify(zone.settings.hosts)) {
      zone = { ...zone, previous_settings: zone.settings, settings: { ...zone.settings, hosts },
        sources: hosts.map((host) => zone!.sources.find((source) => source.host === host) ?? newSource(zoneId, host, now)) };
    }
  }
  state = state!; zone = zone!;
  const permission = await api.permission(), tokens = await api.tokens();
  const candidates = tokens.filter((token) => token.name === logpushTokenName(zone!));
  if (candidates.length > 1) throw new Error("Multiple Logpush destination tokens match the saved operation");
  let token = candidates[0];
  if (token) api.verifyToken(token, state, zone, permission);
  const jobs = await api.jobs(zone);
  if (jobs.length > 1) throw new Error("Multiple Logpush jobs match the saved operation");
  let job = jobs[0];
  if (job && !token) throw new Error("The saved Logpush job has no verified destination token");
  const matches = job ? api.verifyJob(job, state, zone, token!.id) : false;
  if (zone.job_id !== null && !job && action !== "status") throw new Error("The saved Logpush job is missing; preserve its configuration and logs");
  const journal = logpushConfigurationStorage(root, config);
  const save = () => {
    state = logpushConfigurationSchema.parse({ ...state, zones: [...state!.zones.filter((entry) => entry.zone_id !== zoneId), zone!]
      .sort((a, b) => a.zone_id < b.zone_id ? -1 : a.zone_id > b.zone_id ? 1 : 0) });
    journal.replace(state);
  };
  const bucket = await api.bucket(state.bucket_name);
  if (action === "status") {
    const properties = bucket ? await api.inspectBucket(state) : null;
    return { service_id: config.service_id, account_id: config.account_id, zone_id: zoneId, bucket_name: state.bucket_name,
      retention_days: LOGPUSH_RETENTION_DAYS, bucket_exists: bucket !== null, private: properties?.private ?? false,
      retention_valid: properties?.retention_valid ?? false, operation_id: zone.operation_id, settings: zone.settings,
      previous_settings: zone.previous_settings, job_id: job?.id ?? null, job_enabled: job?.enabled ?? null, token_id: token?.id ?? null,
      configuration_matches: matches && !!properties?.private && !!properties?.retention_valid,
      sources: job && matches ? observeSources(zone, job, Date.now()) : zone.sources,
      last_complete_at_ms: job?.last_complete ?? null, last_error_at_ms: job?.last_error ?? null,
      delivery_error: !!job?.error_message || job?.last_error !== null && job?.last_error !== undefined &&
        (job.last_complete === null || job.last_error > job.last_complete), observed_at_ms: Date.now() };
  }
  protectLocalState(root);
  journal.initialize(state);
  if (action === "enable" || action === "disable") {
    if (!job) throw new Error("Finish Logpush setup before enabling or disabling its saved job");
    const enabled = action === "enable";
    if (zone.settings.enabled !== enabled) {
      zone = { ...zone, previous_settings: zone.settings, settings: { ...zone.settings, enabled } };
      if (!enabled) zone.sources = observeSources(zone, { ...job, enabled: false }, Date.now());
    }
  }
  save();
  if (!bucket) {
    if (action !== "setup" || zone.job_id !== null) throw new Error("The saved Logpush bucket is missing");
    await api.createBucket(state.bucket_name);
  }
  const before = await api.inspectBucket(state);
  if (!before.private) throw new Error("Logpush bucket must have r2.dev disabled and no custom domains");
  if (before.conflict) throw new Error("An overlapping lifecycle rule conflicts with 400-day Standard log retention");
  if (!before.retention_valid) {
    if (action !== "setup") throw new Error("Run the saved Logpush setup to verify 400-day retention before changing the job");
    await api.retain(state, before.rules);
  }
  const retained = await api.inspectBucket(state);
  if (!retained.private || !retained.retention_valid) throw new Error("Private 400-day Logpush retention was not verified");
  if (!job) {
    // A token secret is only available in its creation response; an unused token is replaced on explicit setup reruns.
    if (token) { await api.deleteToken(token.id); zone.token_id = null; save(); }
    const credential = await api.createToken(state, zone, permission);
    zone.token_id = credential.id; save();
    job = await api.createJob(state, zone, credential);
    if (!api.verifyJob(job, state, zone, credential.id)) throw new Error("Created Logpush job settings differ");
  } else if (!matches || job.enabled !== zone.settings.enabled) await api.updateJob(zone, job);
  const confirmed = await api.jobs(zone);
  if (confirmed.length !== 1 || !api.verifyJob(confirmed[0]!, state, zone, zone.token_id ?? token!.id)) {
    throw new Error("Applied Logpush job settings were not verified");
  }
  job = confirmed[0]!;
  zone = { ...zone, job_id: job.id, token_id: zone.token_id ?? token!.id, sources: observeSources(zone, job, Date.now()) };
  save();
  return { result: "logpush-configured", service_id: config.service_id, zone_id: zoneId, bucket_name: state.bucket_name,
    retention_days: LOGPUSH_RETENTION_DAYS, private: true, operation_id: zone.operation_id, settings: zone.settings,
    job_id: zone.job_id, token_id: zone.token_id, sources: zone.sources };
}

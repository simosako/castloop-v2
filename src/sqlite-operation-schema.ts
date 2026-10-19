export const OPERATION_DDL = `
CREATE TABLE operation_record_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
INSERT INTO operation_record_schema (id, version) VALUES (1, 1);
CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  parent_operation_id TEXT REFERENCES operations (operation_id), import_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('rss_import', 'show_registration', 'local_install', 'upload', 'publication', 'cleanup')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('show', 'episode')), show_id TEXT NOT NULL, episode_id TEXT, job_id TEXT,
  worker_version_id TEXT NOT NULL, service_config_sha256 TEXT NOT NULL CHECK (length(service_config_sha256) = 64),
  admission_window_id TEXT, expected_show_state_version INTEGER CHECK (expected_show_state_version >= 0),
  expected_episode_lifecycle_version INTEGER CHECK (expected_episode_lifecycle_version >= 0), base_revision_id TEXT,
  base_metadata_sha256 TEXT CHECK (length(base_metadata_sha256) = 64), input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'in_progress', 'succeeded', 'failed', 'blocked', 'cancelled')),
  phase TEXT NOT NULL CHECK (length(phase) BETWEEN 1 AND 64), version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0), updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  finished_at_ms INTEGER CHECK (finished_at_ms >= 0),
  CHECK (parent_operation_id IS NULL OR parent_operation_id <> operation_id),
  CHECK (kind <> 'rss_import' OR (import_id IS NOT NULL AND operation_id = import_id)),
  CHECK (kind <> 'publication' OR (job_id IS NOT NULL AND operation_id = job_id)),
  CHECK ((target_kind = 'show' AND episode_id IS NULL) OR (target_kind = 'episode' AND episode_id IS NOT NULL)),
  CHECK ((state IN ('succeeded', 'failed', 'cancelled') AND finished_at_ms IS NOT NULL) OR
    (state IN ('prepared', 'in_progress', 'blocked') AND finished_at_ms IS NULL))
);
CREATE INDEX operations_parent ON operations (parent_operation_id, operation_id) WHERE parent_operation_id IS NOT NULL;
CREATE INDEX operations_import ON operations (import_id, operation_id) WHERE import_id IS NOT NULL;
CREATE INDEX operations_target ON operations (show_id, episode_id, updated_at_ms, operation_id);
CREATE INDEX operations_pending ON operations (updated_at_ms, operation_id) WHERE state IN ('prepared', 'in_progress', 'blocked');
CREATE TABLE operation_requests (
  request_id TEXT PRIMARY KEY NOT NULL, operation_id TEXT NOT NULL REFERENCES operations (operation_id), client_id TEXT NOT NULL,
  cli_version TEXT NOT NULL CHECK (length(cli_version) BETWEEN 1 AND 64),
  action TEXT NOT NULL CHECK (action IN ('register', 'begin_upload', 'report_upload', 'verify_upload', 'attach_asset', 'submit_publication', 'resume', 'cancel', 'cleanup')),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64), expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0), outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'applied', 'rejected', 'unknown')),
  resolved_at_ms INTEGER CHECK (resolved_at_ms >= 0), reason_code TEXT CHECK (length(reason_code) BETWEEN 1 AND 64),
  CHECK ((outcome IN ('applied', 'rejected') AND resolved_at_ms IS NOT NULL) OR (outcome IN ('accepted', 'unknown') AND resolved_at_ms IS NULL))
);
CREATE INDEX operation_requests_client ON operation_requests (client_id, received_at_ms, request_id);
CREATE INDEX operation_requests_operation ON operation_requests (operation_id, received_at_ms, request_id);
CREATE TABLE operation_assets (
  upload_id TEXT PRIMARY KEY NOT NULL, operation_id TEXT NOT NULL REFERENCES operations (operation_id),
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('show_metadata', 'episode_metadata', 'cover_jpg', 'cover_png', 'audio')),
  object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 1 AND 256),
  length_bytes INTEGER NOT NULL CHECK (length_bytes BETWEEN 1 AND 300000000), sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  duration_seconds REAL CHECK (duration_seconds > 0),
  upload_state TEXT NOT NULL CHECK (upload_state IN ('prepared', 'put_requested', 'put_acknowledged', 'verified', 'attached', 'unknown', 'cancelled')),
  put_etag TEXT, object_version TEXT, put_acknowledged_at_ms INTEGER CHECK (put_acknowledged_at_ms >= 0),
  verified_at_ms INTEGER CHECK (verified_at_ms >= 0), attached_at_ms INTEGER CHECK (attached_at_ms >= 0),
  cleanup_operation_id TEXT REFERENCES operations (operation_id),
  deletion_state TEXT NOT NULL DEFAULT 'none' CHECK (deletion_state IN ('none', 'requested', 'deleted', 'unknown')),
  deleted_at_ms INTEGER CHECK (deleted_at_ms >= 0),
  CHECK (asset_kind NOT IN ('cover_jpg', 'cover_png') OR length_bytes <= 5000000),
  CHECK ((asset_kind = 'audio' AND duration_seconds IS NOT NULL) OR (asset_kind <> 'audio' AND duration_seconds IS NULL)),
  CHECK ((put_etag IS NULL AND object_version IS NULL AND put_acknowledged_at_ms IS NULL) OR
    (put_etag IS NOT NULL AND length(put_etag) > 0 AND object_version IS NOT NULL AND length(object_version) > 0 AND put_acknowledged_at_ms IS NOT NULL)),
  CHECK (verified_at_ms IS NULL OR put_etag IS NOT NULL), CHECK (attached_at_ms IS NULL OR verified_at_ms IS NOT NULL),
  CHECK (upload_state NOT IN ('put_acknowledged', 'verified', 'attached') OR put_etag IS NOT NULL),
  CHECK (upload_state NOT IN ('verified', 'attached') OR verified_at_ms IS NOT NULL),
  CHECK (upload_state <> 'attached' OR attached_at_ms IS NOT NULL), CHECK (deletion_state = 'none' OR put_etag IS NOT NULL),
  CHECK ((deletion_state = 'none' AND cleanup_operation_id IS NULL AND deleted_at_ms IS NULL) OR
    (deletion_state IN ('requested', 'unknown') AND cleanup_operation_id IS NOT NULL AND deleted_at_ms IS NULL) OR
    (deletion_state = 'deleted' AND cleanup_operation_id IS NOT NULL AND deleted_at_ms IS NOT NULL))
);
CREATE INDEX operation_assets_operation ON operation_assets (operation_id, upload_id);
CREATE INDEX operation_assets_cleanup ON operation_assets (cleanup_operation_id, upload_id) WHERE cleanup_operation_id IS NOT NULL;
CREATE TABLE operation_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES operations (operation_id),
  operation_version INTEGER NOT NULL CHECK (operation_version > 0), request_id TEXT REFERENCES operation_requests (request_id),
  upload_id TEXT REFERENCES operation_assets (upload_id), actor_type TEXT NOT NULL CHECK (actor_type IN ('client', 'worker')),
  invocation_id TEXT NOT NULL, worker_version_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'in_progress', 'succeeded', 'failed', 'blocked', 'cancelled')),
  phase TEXT NOT NULL CHECK (length(phase) BETWEEN 1 AND 64), recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
  reason_code TEXT CHECK (length(reason_code) BETWEEN 1 AND 64), UNIQUE (operation_id, operation_version),
  CHECK (actor_type <> 'client' OR request_id IS NOT NULL)
);
`;

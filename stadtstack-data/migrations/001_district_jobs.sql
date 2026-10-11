-- R1: private originals live in the filesystem CAS, never in release_files.
-- Apply through district-jobs.ts migrate; the runner records this file's byte hash.
-- Attended by default; bounded unattended mode needs separately pinned notification approval.
-- Expired leases are held, not auto-retried. R1 does not authorize paid APIs.
CREATE SCHEMA IF NOT EXISTS district_pipeline;
CREATE TABLE district_pipeline.artifacts (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('source_original','text','parser_output','provider_response','receipt','manifest','derived')),
  mime_type text NOT NULL, byte_length bigint NOT NULL CHECK (byte_length >= 0),
  storage_key text NOT NULL UNIQUE CHECK (storage_key ~ '^sha256/[a-f0-9]{2}/[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retention_until timestamptz, disposition text NOT NULL DEFAULT 'retained' CHECK (disposition IN ('retained','excluded','removed','backup_restricted')),
  CHECK (storage_key = 'sha256/' || left(sha256,2) || '/' || sha256)
);
CREATE TABLE district_pipeline.source_snapshots (
  id uuid PRIMARY KEY, publisher_id text NOT NULL, source_id text NOT NULL,
  municipality_id text NOT NULL, ags text NOT NULL CHECK (ags ~ '^[0-9]{8}$'), tenant text,
  resource_identity text NOT NULL, request_method text NOT NULL CHECK (request_method IN ('GET','POST')),
  request_selector_sha256 text NOT NULL CHECK (request_selector_sha256 ~ '^[a-f0-9]{64}$'),
  observation_window text NOT NULL, source_version text, retrieved_at timestamptz NOT NULL,
  scope_sha256 text NOT NULL CHECK (scope_sha256 ~ '^[a-f0-9]{64}$'),
  UNIQUE (publisher_id,source_id,scope_sha256,resource_identity,request_method,request_selector_sha256,observation_window)
);
CREATE TABLE district_pipeline.policy_decisions (
  id uuid PRIMARY KEY, source_snapshot_id uuid NOT NULL REFERENCES district_pipeline.source_snapshots(id),
  proof_sha256 text NOT NULL UNIQUE CHECK (proof_sha256 ~ '^[a-f0-9]{64}$'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  receipt_json jsonb NOT NULL CHECK(jsonb_typeof(receipt_json)='object'),
  state text NOT NULL CHECK (state IN ('allowed','blocked_policy','blocked_access','held_origin','excluded')),
  observed_robots text NOT NULL CHECK (observed_robots IN ('allowed','disallowed','unknown')),
  owner_robots_override boolean NOT NULL, origin_evidence_sha256 text CHECK (origin_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  opt_out_version text NOT NULL, policy_version text NOT NULL, checked_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL, reason_code text NOT NULL, CHECK (expires_at > checked_at)
);
CREATE TABLE district_pipeline.representations (
  id uuid PRIMARY KEY, source_snapshot_id uuid NOT NULL REFERENCES district_pipeline.source_snapshots(id),
  artifact_sha256 text NOT NULL REFERENCES district_pipeline.artifacts(sha256),
  policy_decision_id uuid NOT NULL REFERENCES district_pipeline.policy_decisions(id),
  final_url text NOT NULL, redirect_chain jsonb NOT NULL CHECK (jsonb_typeof(redirect_chain)='array'),
  fetched_at timestamptz NOT NULL, etag text, last_modified text, mime_type text NOT NULL,
  admitted_at timestamptz NOT NULL, CHECK (fetched_at<=admitted_at),
  admission text NOT NULL CHECK (admission IN ('inspection','admitted','excluded')),
  UNIQUE (source_snapshot_id,artifact_sha256,policy_decision_id)
);
CREATE FUNCTION district_pipeline.check_representation_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.admission='admitted' AND NOT EXISTS (
    SELECT 1 FROM district_pipeline.policy_decisions p
    WHERE p.id=NEW.policy_decision_id AND p.source_snapshot_id=NEW.source_snapshot_id
      AND p.source_sha256=NEW.artifact_sha256 AND p.state='allowed'
      AND p.checked_at<=NEW.admitted_at AND p.expires_at>NEW.admitted_at
      AND NEW.fetched_at<=NEW.admitted_at
  ) THEN RAISE EXCEPTION 'Representation admission lacks byte-bound current policy'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER representation_admission BEFORE INSERT OR UPDATE ON district_pipeline.representations
FOR EACH ROW EXECUTE FUNCTION district_pipeline.check_representation_admission();
CREATE TABLE district_pipeline.host_lanes (
  lane_key text PRIMARY KEY, normalized_host text NOT NULL, shared_service_group text,
  max_in_flight integer NOT NULL DEFAULT 1 CHECK (max_in_flight BETWEEN 1 AND 4),
  min_start_interval_ms integer NOT NULL DEFAULT 2000 CHECK (min_start_interval_ms >= 2000),
  next_start_at timestamptz NOT NULL DEFAULT '-infinity', last_started_at timestamptz,
  paused_reason text, retry_after timestamptz
);
CREATE TABLE district_pipeline.provider_budgets (
  id uuid PRIMARY KEY, provider text NOT NULL, currency text NOT NULL CHECK (currency='USD'),
  owner_approval_sha256 text NOT NULL CHECK (owner_approval_sha256 ~ '^[a-f0-9]{64}$'),
  cap_micro_usd bigint NOT NULL CHECK (cap_micro_usd >= 0),
  spent_micro_usd bigint NOT NULL DEFAULT 0 CHECK (spent_micro_usd >= 0),
  reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  pause_fraction numeric NOT NULL DEFAULT 0.8 CHECK (pause_fraction > 0 AND pause_fraction <= 0.8),
  expires_at timestamptz NOT NULL, paused_reason text
);
CREATE TABLE district_pipeline.preauthorizations (
  id uuid PRIMARY KEY, approval_sha256 text NOT NULL UNIQUE CHECK (approval_sha256 ~ '^[a-f0-9]{64}$'), approved_by text NOT NULL,
  approved_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  allowed_job_keys text[] NOT NULL CHECK (cardinality(allowed_job_keys)>0),
  allowed_ags text[] NOT NULL CHECK (cardinality(allowed_ags)>0),
  max_jobs integer NOT NULL CHECK (max_jobs BETWEEN 1 AND 10000),
  max_elapsed_ms integer NOT NULL CHECK (max_elapsed_ms BETWEEN 1 AND 86400000),
  jobs_started integer NOT NULL DEFAULT 0 CHECK (jobs_started >= 0), first_started_at timestamptz,
  category text NOT NULL CHECK (category IN ('production','evaluation','development')),
  allow_paid boolean NOT NULL DEFAULT false CHECK (allow_paid=false),
  execution_mode text NOT NULL DEFAULT 'attended' CHECK (execution_mode IN ('attended','bounded_unattended')),
  notification_approval_sha256 text CHECK (notification_approval_sha256 ~ '^[a-f0-9]{64}$'),
  notification_destination_sha256 text CHECK (notification_destination_sha256 ~ '^[a-f0-9]{64}$'),
  notification_provider text,
  CHECK (execution_mode='attended' OR (notification_approval_sha256 IS NOT NULL AND notification_destination_sha256 IS NOT NULL AND notification_provider IS NOT NULL AND notification_provider<>'')),
  state text NOT NULL DEFAULT 'approved' CHECK (state IN ('approved','revoked')),
  CHECK (expires_at>approved_at), CHECK (jobs_started<=max_jobs)
);
CREATE TABLE district_pipeline.executor_runs (
  id uuid PRIMARY KEY, authorization_id uuid NOT NULL REFERENCES district_pipeline.preauthorizations(id),
  owner_present boolean NOT NULL,
  execution_mode text NOT NULL CHECK (execution_mode IN ('attended','bounded_unattended')),
  CHECK (owner_present=(execution_mode='attended')),
  state text NOT NULL CHECK (state IN ('running','completed','held')),
  reason_code text, started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  max_jobs integer NOT NULL CHECK (max_jobs > 0), max_elapsed_ms integer NOT NULL CHECK (max_elapsed_ms > 0)
);
CREATE UNIQUE INDEX one_running_r1_executor ON district_pipeline.executor_runs ((state)) WHERE state='running';
CREATE TABLE district_pipeline.owner_notifications (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES district_pipeline.executor_runs(id),
  phase text NOT NULL CHECK(phase IN ('startup','disposition')), UNIQUE(run_id,phase),
  notification_approval_sha256 text NOT NULL CHECK(notification_approval_sha256 ~ '^[a-f0-9]{64}$'),
  destination_sha256 text NOT NULL CHECK(destination_sha256 ~ '^[a-f0-9]{64}$'), expected_provider text NOT NULL,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'), payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), delivered_at timestamptz,
  provider text, provider_message_id text, acknowledged_at timestamptz,
  CHECK ((state='delivered')=(provider IS NOT NULL AND provider_message_id IS NOT NULL AND acknowledged_at IS NOT NULL)),
  CHECK (provider IS NULL OR provider=expected_provider)
);
CREATE UNIQUE INDEX unique_provider_notification_ack ON district_pipeline.owner_notifications(provider,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE FUNCTION district_pipeline.pin_preauthorization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['jobs_started','first_started_at','state']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['jobs_started','first_started_at','state'])
    OR NEW.jobs_started<OLD.jobs_started OR (OLD.first_started_at IS NOT NULL AND NEW.first_started_at IS DISTINCT FROM OLD.first_started_at)
    OR (OLD.state='revoked' AND NEW.state<>'revoked')
  THEN RAISE EXCEPTION 'Preauthorization scope is immutable; new approval required'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pin_preauthorization BEFORE UPDATE ON district_pipeline.preauthorizations FOR EACH ROW EXECUTE FUNCTION district_pipeline.pin_preauthorization();
CREATE TABLE district_pipeline.jobs (
  id uuid PRIMARY KEY, job_key text NOT NULL UNIQUE CHECK (job_key ~ '^[a-f0-9]{64}$'),
  canonicalization_version text NOT NULL, semantic_contract_sha256 text NOT NULL CHECK (semantic_contract_sha256 ~ '^[a-f0-9]{64}$'),
  step text NOT NULL, lane text NOT NULL, source_id text NOT NULL, municipality_id text NOT NULL,
  ags text NOT NULL CHECK (ags ~ '^[0-9]{8}$'), spec jsonb NOT NULL CHECK (jsonb_typeof(spec)='object'),
  policy_proof_sha256 text REFERENCES district_pipeline.policy_decisions(proof_sha256),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','leased','succeeded','no_supported_case','blocked_policy','blocked_access','held_origin','held_quality','held_execution','deferred','failed_execution','cancelled','superseded')),
  priority integer NOT NULL DEFAULT 0, not_before timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  host_lane_key text REFERENCES district_pipeline.host_lanes(lane_key), budget_id uuid REFERENCES district_pipeline.provider_budgets(id),
  reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  lease_owner uuid REFERENCES district_pipeline.executor_runs(id), lease_expires_at timestamptz,
  attempt_started_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0), attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  cancellation_requested boolean NOT NULL DEFAULT false, reason_code text,
  claimed_dependency_receipt_ids uuid[] NOT NULL DEFAULT '{}',
  CHECK ((state='leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR (state<>'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)),
  CHECK (reserved_micro_usd=0 OR budget_id IS NOT NULL)
);
CREATE INDEX claimable_jobs ON district_pipeline.jobs(priority DESC,created_at) WHERE state IN ('queued','deferred');
CREATE TABLE district_pipeline.job_input_artifacts (
  job_id uuid NOT NULL REFERENCES district_pipeline.jobs(id), artifact_sha256 text NOT NULL REFERENCES district_pipeline.artifacts(sha256),
  PRIMARY KEY(job_id,artifact_sha256)
);
CREATE TABLE district_pipeline.step_receipts (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES district_pipeline.jobs(id), run_id uuid NOT NULL REFERENCES district_pipeline.executor_runs(id),
  attempt integer NOT NULL CHECK (attempt>0), fencing_token bigint NOT NULL CHECK (fencing_token>0),
  outcome text NOT NULL CHECK (outcome IN ('succeeded','no_supported_case','blocked_policy','blocked_access','held_origin','held_quality','held_execution','deferred','failed_execution','cancelled','superseded')),
  receipt_sha256 text NOT NULL UNIQUE CHECK (receipt_sha256 ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'), committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(job_id,attempt), UNIQUE(job_id,fencing_token)
);
CREATE TABLE district_pipeline.job_dependencies (
  job_id uuid NOT NULL REFERENCES district_pipeline.jobs(id), predecessor_job_id uuid NOT NULL REFERENCES district_pipeline.jobs(id),
  expected_receipt_sha256 text CHECK (expected_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(job_id,predecessor_job_id), CHECK(job_id<>predecessor_job_id)
);
CREATE TABLE district_pipeline.step_receipt_dependencies (
  receipt_id uuid NOT NULL REFERENCES district_pipeline.step_receipts(id), dependency_receipt_id uuid NOT NULL REFERENCES district_pipeline.step_receipts(id),
  PRIMARY KEY(receipt_id,dependency_receipt_id), CHECK(receipt_id<>dependency_receipt_id)
);
CREATE TABLE district_pipeline.job_output_artifacts (
  receipt_id uuid NOT NULL REFERENCES district_pipeline.step_receipts(id), artifact_sha256 text NOT NULL REFERENCES district_pipeline.artifacts(sha256),
  PRIMARY KEY(receipt_id,artifact_sha256)
);
CREATE TABLE district_pipeline.host_lane_leases (
  lane_key text NOT NULL REFERENCES district_pipeline.host_lanes(lane_key), job_id uuid NOT NULL REFERENCES district_pipeline.jobs(id),
  fencing_token bigint NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(lane_key,job_id)
);
CREATE TABLE district_pipeline.provider_reservations (
  id uuid PRIMARY KEY, budget_id uuid NOT NULL REFERENCES district_pipeline.provider_budgets(id), job_id uuid NOT NULL REFERENCES district_pipeline.jobs(id),
  fencing_token bigint NOT NULL, reserved_micro_usd bigint NOT NULL CHECK (reserved_micro_usd>0),
  actual_micro_usd bigint CHECK(actual_micro_usd>=0),
  state text NOT NULL CHECK (state IN ('reserved','pending_usage','settled','held_uncertain')),
  submission_intent_sha256 text CHECK(submission_intent_sha256 ~ '^[a-f0-9]{64}$'), provider_request_id text, batch_id text,
  UNIQUE(job_id,fencing_token)
);
CREATE TABLE district_pipeline.case_identities (
  id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'), namespace text NOT NULL, issuer text NOT NULL, native_id text NOT NULL,
  municipality_id text NOT NULL, kind text NOT NULL, version integer NOT NULL CHECK(version>0),
  provenance_sha256 text NOT NULL CHECK(provenance_sha256 ~ '^[a-f0-9]{64}$'), UNIQUE(namespace,issuer,native_id,municipality_id,version)
);
CREATE TABLE district_pipeline.entity_identities (
  id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'), namespace text NOT NULL, issuer text NOT NULL, native_id text NOT NULL,
  kind text NOT NULL, version integer NOT NULL CHECK(version>0),
  provenance_sha256 text NOT NULL CHECK(provenance_sha256 ~ '^[a-f0-9]{64}$'), UNIQUE(namespace,issuer,native_id,version)
);
CREATE TABLE district_pipeline.identity_assertions (
  id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'), version integer NOT NULL CHECK(version>0),
  case_identity_id text REFERENCES district_pipeline.case_identities(id), entity_identity_id text REFERENCES district_pipeline.entity_identities(id),
  subject_id text NOT NULL, object_id text NOT NULL, relation text NOT NULL,
  status text NOT NULL CHECK(status IN ('accepted','proposed','contested','retracted')),
  evidence_sha256 text[] NOT NULL CHECK(cardinality(evidence_sha256)>0), rule_version text NOT NULL, adjudicator text NOT NULL,
  valid_from date, valid_to date, from_precision text NOT NULL, to_precision text NOT NULL,
  from_inclusive boolean, to_inclusive boolean, temporal_expression_sha256 text NOT NULL CHECK(temporal_expression_sha256 ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL, supersedes_id text REFERENCES district_pipeline.identity_assertions(id),
  CHECK(case_identity_id IS NOT NULL OR entity_identity_id IS NOT NULL), CHECK(valid_to IS NULL OR valid_from IS NULL OR valid_to>=valid_from)
);
CREATE TABLE district_pipeline.release_candidates (
  id uuid PRIMARY KEY, release_id text NOT NULL UNIQUE, manifest_sha256 text NOT NULL UNIQUE CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  publication_job_id uuid NOT NULL REFERENCES district_pipeline.jobs(id), source_receipt_id uuid NOT NULL REFERENCES district_pipeline.step_receipts(id),
  predecessor_release_id uuid REFERENCES district_pipeline.release_candidates(id), genesis_contract_sha256 text CHECK(genesis_contract_sha256 ~ '^[a-f0-9]{64}$'),
  predecessor_state_sha256 text CHECK(predecessor_state_sha256 ~ '^[a-f0-9]{64}$'),
  graph_as_of timestamptz NOT NULL, schema_version text NOT NULL, policy_snapshot_sha256 text NOT NULL CHECK(policy_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  approval_sha256 text CHECK(approval_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK ((predecessor_release_id IS NULL)=(genesis_contract_sha256 IS NOT NULL)),
  CHECK ((predecessor_release_id IS NOT NULL)=(predecessor_state_sha256 IS NOT NULL)), CHECK(predecessor_release_id IS DISTINCT FROM id)
);
CREATE TABLE district_pipeline.release_files (
  release_candidate_id uuid NOT NULL REFERENCES district_pipeline.release_candidates(id),
  path text NOT NULL CHECK(path !~ '(^/|(^|/)\.\.(/|$)|\\)' AND path<>''),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), byte_length bigint NOT NULL CHECK(byte_length>=0),
  content_kind text NOT NULL CHECK(content_kind IN ('facts','attribution','short_quotes','metadata')),
  PRIMARY KEY(release_candidate_id,path)
);
CREATE TABLE district_pipeline.active_release (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), release_candidate_id uuid NOT NULL REFERENCES district_pipeline.release_candidates(id),
  activated_at timestamptz NOT NULL, approval_sha256 text NOT NULL CHECK(approval_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE FUNCTION district_pipeline.immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable pipeline record'; END $$;
CREATE TRIGGER immutable_source_snapshots BEFORE UPDATE OR DELETE ON district_pipeline.source_snapshots FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
CREATE FUNCTION district_pipeline.pin_policy_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state')
    OR (NEW.state IS DISTINCT FROM OLD.state AND OLD.state<>'allowed')
  THEN RAISE EXCEPTION 'Policy proof metadata is immutable; new proof required'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pin_policy_receipt BEFORE UPDATE ON district_pipeline.policy_decisions FOR EACH ROW EXECUTE FUNCTION district_pipeline.pin_policy_receipt();
CREATE TRIGGER retain_policy_receipt BEFORE DELETE ON district_pipeline.policy_decisions FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
CREATE FUNCTION district_pipeline.pin_owner_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['state','attempts','delivered_at','provider','provider_message_id','acknowledged_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','attempts','delivered_at','provider','provider_message_id','acknowledged_at'])
    OR NEW.attempts<OLD.attempts OR (OLD.state='delivered' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
  THEN RAISE EXCEPTION 'Notification payload and delivered acknowledgement are immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pin_owner_notification BEFORE UPDATE ON district_pipeline.owner_notifications FOR EACH ROW EXECUTE FUNCTION district_pipeline.pin_owner_notification();
CREATE TRIGGER immutable_receipts BEFORE UPDATE OR DELETE ON district_pipeline.step_receipts FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
CREATE TRIGGER immutable_receipt_dependencies BEFORE UPDATE OR DELETE ON district_pipeline.step_receipt_dependencies FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
CREATE TRIGGER immutable_output_bindings BEFORE UPDATE OR DELETE ON district_pipeline.job_output_artifacts FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
CREATE FUNCTION district_pipeline.check_output_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM district_pipeline.step_receipts r WHERE r.id=NEW.receipt_id AND (r.receipt->'outputHashes') @> to_jsonb(ARRAY[NEW.artifact_sha256]))
  THEN RAISE EXCEPTION 'Output binding is not in immutable receipt'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_output_binding BEFORE INSERT ON district_pipeline.job_output_artifacts FOR EACH ROW EXECUTE FUNCTION district_pipeline.check_output_binding();
CREATE FUNCTION district_pipeline.check_receipt_output_set() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(NEW.receipt->'outputHashes') IS DISTINCT FROM 'array'
    OR (SELECT count(*) FROM district_pipeline.job_output_artifacts o WHERE o.receipt_id=NEW.id) IS DISTINCT FROM jsonb_array_length(NEW.receipt->'outputHashes')::bigint
  THEN RAISE EXCEPTION 'Receipt output set is incomplete'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER check_receipt_output_set AFTER INSERT ON district_pipeline.step_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION district_pipeline.check_receipt_output_set();
CREATE TRIGGER immutable_release_candidates BEFORE UPDATE OR DELETE ON district_pipeline.release_candidates FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
CREATE TRIGGER immutable_release_files BEFORE UPDATE OR DELETE ON district_pipeline.release_files FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();

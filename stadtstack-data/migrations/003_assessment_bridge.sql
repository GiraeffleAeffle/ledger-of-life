-- VM-only bridge metadata. Raw original/context/provider bytes remain in managed private CAS.
-- One intent per canonical job: reconnects never authorize another model submission.
CREATE TABLE district_pipeline.assessment_bridge_leases (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES district_pipeline.jobs(id),
  run_id uuid NOT NULL REFERENCES district_pipeline.executor_runs(id),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  item_sha256 text NOT NULL REFERENCES district_pipeline.artifacts(sha256),
  request_artifact_sha256 text NOT NULL REFERENCES district_pipeline.artifacts(sha256),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  authority_id text NOT NULL,
  authority_sha256 text NOT NULL CHECK (authority_sha256 ~ '^[a-f0-9]{64}$'),
  policy_snapshot_sha256 text NOT NULL CHECK (policy_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  client_contract_sha256 text NOT NULL CHECK (client_contract_sha256 ~ '^[a-f0-9]{64}$'),
  role text NOT NULL CHECK (role = 'B'),
  provider text NOT NULL CHECK (provider = 'anthropic-subscription'),
  requested_model text NOT NULL CHECK (requested_model = 'claude-haiku-5-5'),
  state text NOT NULL CHECK (state IN ('ready','active','held','expired','cancelled','submitted')),
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  client_id text CHECK (client_id ~ '^[a-zA-Z0-9._:-]{1,128}$'),
  claimed_at timestamptz,
  expires_at timestamptz NOT NULL,
  last_checked_at timestamptz,
  receipt_sha256 text REFERENCES district_pipeline.artifacts(sha256),
  purge_ack_sha256 text CHECK (purge_ack_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (deadline_at > created_at),
  CHECK (expires_at <= deadline_at),
  CHECK ((claimed_at IS NULL) = (client_id IS NULL)),
  CHECK (state <> 'active' OR claimed_at IS NOT NULL),
  CHECK (state <> 'submitted' OR (receipt_sha256 IS NOT NULL AND purge_ack_sha256 IS NOT NULL))
);
CREATE UNIQUE INDEX one_bridge_lease_per_fence ON district_pipeline.assessment_bridge_leases(job_id,fencing_token);
CREATE UNIQUE INDEX one_live_bridge_lease ON district_pipeline.assessment_bridge_leases(job_id) WHERE state IN ('ready','active');
CREATE TABLE district_pipeline.assessment_bridge_submission_intents (
  lease_id uuid PRIMARY KEY REFERENCES district_pipeline.assessment_bridge_leases(id),
  job_id uuid NOT NULL UNIQUE REFERENCES district_pipeline.jobs(id),
  run_id uuid NOT NULL REFERENCES district_pipeline.executor_runs(id),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  intent_sha256 text NOT NULL UNIQUE CHECK (intent_sha256 ~ '^[a-f0-9]{64}$'),
  client_id text NOT NULL CHECK (client_id ~ '^[a-zA-Z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE district_pipeline.assessment_bridge_purge_acknowledgements (
  lease_id uuid PRIMARY KEY REFERENCES district_pipeline.assessment_bridge_leases(id),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  ack_sha256 text NOT NULL CHECK (ack_sha256 ~ '^[a-f0-9]{64}$'),
  acknowledgement jsonb NOT NULL CHECK (jsonb_typeof(acknowledgement) = 'object'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (acknowledgement->>'sourceFiles' = '0' AND acknowledgement->>'responseFiles' = '0'
    AND acknowledgement->>'modelFileWritesDenied' = 'true')
);
CREATE TABLE district_pipeline.assessment_bridge_submissions (
  lease_id uuid PRIMARY KEY REFERENCES district_pipeline.assessment_bridge_leases(id),
  submission_sha256 text NOT NULL UNIQUE CHECK (submission_sha256 ~ '^[a-f0-9]{64}$'),
  provider_response_sha256 text NOT NULL REFERENCES district_pipeline.artifacts(sha256),
  answer_artifact_sha256 text NOT NULL REFERENCES district_pipeline.artifacts(sha256),
  receipt_artifact_sha256 text REFERENCES district_pipeline.artifacts(sha256),
  reconciliation_input_sha256 text NOT NULL REFERENCES district_pipeline.artifacts(sha256),
  provider_request_id text,
  provider_response_id text,
  state text NOT NULL CHECK (state IN ('accepted','rejected')),
  reason_code text NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'accepted') = (receipt_artifact_sha256 IS NOT NULL))
);
CREATE TABLE district_pipeline.assessment_bridge_events (
  id uuid PRIMARY KEY,
  lease_id uuid NOT NULL REFERENCES district_pipeline.assessment_bridge_leases(id),
  state text NOT NULL CHECK (state IN ('ready','active','held','expired','cancelled','submitted')),
  reason_code text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION district_pipeline.pin_assessment_bridge_lease() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['state','reason_code','client_id','claimed_at','expires_at','last_checked_at','receipt_sha256','purge_ack_sha256'])
      IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['state','reason_code','client_id','claimed_at','expires_at','last_checked_at','receipt_sha256','purge_ack_sha256'])
    OR (OLD.claimed_at IS NOT NULL AND (NEW.claimed_at IS DISTINCT FROM OLD.claimed_at OR NEW.client_id IS DISTINCT FROM OLD.client_id))
    OR (OLD.state <> 'ready' AND NEW.state = 'ready')
    OR (OLD.state IN ('held','expired','cancelled','submitted') AND NEW.state IS DISTINCT FROM OLD.state)
    OR (OLD.receipt_sha256 IS NOT NULL AND NEW.receipt_sha256 IS DISTINCT FROM OLD.receipt_sha256)
    OR (OLD.purge_ack_sha256 IS NOT NULL AND NEW.purge_ack_sha256 IS DISTINCT FROM OLD.purge_ack_sha256)
  THEN RAISE EXCEPTION 'Bridge identity, terminal disposition and acknowledgements are immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pin_assessment_bridge_lease BEFORE UPDATE ON district_pipeline.assessment_bridge_leases FOR EACH ROW EXECUTE FUNCTION district_pipeline.pin_assessment_bridge_lease();
CREATE TRIGGER retain_assessment_bridge_lease BEFORE DELETE ON district_pipeline.assessment_bridge_leases FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
CREATE TRIGGER immutable_assessment_bridge_intents BEFORE UPDATE OR DELETE ON district_pipeline.assessment_bridge_submission_intents FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
CREATE TRIGGER immutable_assessment_bridge_purges BEFORE UPDATE OR DELETE ON district_pipeline.assessment_bridge_purge_acknowledgements FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
CREATE TRIGGER immutable_assessment_bridge_submissions BEFORE UPDATE OR DELETE ON district_pipeline.assessment_bridge_submissions FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
CREATE TRIGGER immutable_assessment_bridge_events BEFORE UPDATE OR DELETE ON district_pipeline.assessment_bridge_events FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();

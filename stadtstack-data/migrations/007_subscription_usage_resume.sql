-- Additive evidence/dispositions. Existing intents, holds and receipts are never rewritten.
CREATE TABLE district_pipeline.r1_subscription_usage_holds (
 id uuid PRIMARY KEY,
 provider text NOT NULL CHECK(provider IN ('openai-subscription','anthropic-subscription')),
 authorization_id uuid NOT NULL REFERENCES district_pipeline.preauthorizations(id),
 job_id uuid NOT NULL REFERENCES district_pipeline.jobs(id),
 codex_authorization_id uuid UNIQUE REFERENCES district_pipeline.r1_codex_usage_holds(authorization_id),
 bridge_lease_id uuid UNIQUE REFERENCES district_pipeline.assessment_bridge_leases(id),
 limit_kind text NOT NULL CHECK(limit_kind IN ('usage_limit','rate_limit')),
 reset_at timestamptz,
 observed_at timestamptz NOT NULL,
 no_output boolean NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((provider='openai-subscription' AND codex_authorization_id IS NOT NULL AND codex_authorization_id=authorization_id AND bridge_lease_id IS NULL) OR
       (provider='anthropic-subscription' AND codex_authorization_id IS NULL AND bridge_lease_id IS NOT NULL))
);
CREATE TABLE district_pipeline.r1_subscription_resumptions (
 hold_id uuid NOT NULL REFERENCES district_pipeline.r1_subscription_usage_holds(id),
 job_id uuid NOT NULL REFERENCES district_pipeline.jobs(id),
 authorization_id uuid NOT NULL REFERENCES district_pipeline.preauthorizations(id),
 source_scope_sha256 text NOT NULL CHECK(source_scope_sha256 ~ '^[a-f0-9]{64}$'),
 approval_sha256 text NOT NULL CHECK(approval_sha256 ~ '^[a-f0-9]{64}$'),
 owner_approval_sha256 text NOT NULL CHECK(owner_approval_sha256 ~ '^[a-f0-9]{64}$'),
 parent_approval_sha256 text NOT NULL CHECK(parent_approval_sha256 ~ '^[a-f0-9]{64}$'),
 prior_receipt_sha256 text NOT NULL REFERENCES district_pipeline.step_receipts(receipt_sha256),
 resumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(hold_id,job_id)
);
CREATE TRIGGER subscription_usage_hold_immutable BEFORE UPDATE OR DELETE ON district_pipeline.r1_subscription_usage_holds FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
CREATE TRIGGER subscription_resumption_immutable BEFORE UPDATE OR DELETE ON district_pipeline.r1_subscription_resumptions FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
-- A new fence may submit only after the broker proves every earlier exposure
-- was an empty typed quota failure with a committed reset disposition.
-- Preserve every historical intent; never recycle its lease or fencing token.
ALTER TABLE district_pipeline.assessment_bridge_submission_intents
 DROP CONSTRAINT assessment_bridge_submission_intents_job_id_key;
ALTER TABLE district_pipeline.assessment_bridge_submission_intents
 ADD CONSTRAINT assessment_bridge_intent_per_fence UNIQUE(job_id,fencing_token);
CREATE FUNCTION district_pipeline.guard_subscription_bridge_retry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(
  SELECT 1 FROM district_pipeline.assessment_bridge_submission_intents prior
  WHERE prior.job_id=NEW.job_id AND NOT EXISTS(
   SELECT 1 FROM district_pipeline.r1_subscription_usage_holds h
   JOIN district_pipeline.r1_subscription_resumptions disposition ON disposition.hold_id=h.id AND disposition.job_id=NEW.job_id
   JOIN district_pipeline.preauthorizations approved ON approved.id=disposition.authorization_id
   JOIN district_pipeline.executor_runs run ON run.id=NEW.run_id
   JOIN district_pipeline.preauthorizations current ON current.id=run.authorization_id
   JOIN district_pipeline.jobs job ON job.id=NEW.job_id
   WHERE h.bridge_lease_id=prior.lease_id AND h.job_id=NEW.job_id AND h.provider='anthropic-subscription' AND h.no_output
    AND h.reset_at<=clock_timestamp() AND approved.approved_at>=h.reset_at AND approved.approved_at>h.observed_at
    AND current.approved_at>=approved.approved_at AND current.state='approved' AND current.expires_at>clock_timestamp()
    AND run.state='running' AND job.state='leased' AND job.lease_owner=NEW.run_id AND job.fencing_token=NEW.fencing_token
    AND job.spec->'selector'->>'transport'='vm-omp'
    AND disposition.owner_approval_sha256='9882aa1a3938c41a358760705705b943b31e569e11a7b5a2f6579c8661a6b028'
    AND disposition.parent_approval_sha256='2ac6267d17ed08452665a0b2de92ec4da89915fe8619b668b85585301327502b'
  )
 ) THEN RAISE EXCEPTION 'Ambiguous bridge submission intent cannot be retried'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_subscription_bridge_retry BEFORE INSERT ON district_pipeline.assessment_bridge_submission_intents FOR EACH ROW EXECUTE FUNCTION district_pipeline.guard_subscription_bridge_retry();

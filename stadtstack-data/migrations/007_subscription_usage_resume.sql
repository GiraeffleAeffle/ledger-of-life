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
 failure_proof jsonb,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((provider='openai-subscription' AND codex_authorization_id IS NOT NULL AND codex_authorization_id=authorization_id AND bridge_lease_id IS NULL AND failure_proof IS NULL) OR
       (provider='anthropic-subscription' AND codex_authorization_id IS NULL AND bridge_lease_id IS NOT NULL AND jsonb_typeof(failure_proof)='object') IS TRUE),
 CHECK(provider<>'anthropic-subscription' OR NOT no_output OR
       (failure_proof->>'version'='omp-provider-limit-failure-v1' AND failure_proof->>'exitCode'='0'
        AND failure_proof->>'terminalFrame'='assistant_turn_agent_error'
        AND failure_proof->>'streamSha256' ~ '^[a-f0-9]{64}$'
        AND failure_proof->>'terminalMessageSha256' ~ '^[a-f0-9]{64}$') IS TRUE)
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
-- A boolean certification alone never proves an earlier exposure safe. Bind the
-- complete normal-exit frame to the exact claimed lease, immutable intent and
-- canonical held receipt, with no separately recorded successful submission.
CREATE VIEW district_pipeline.r1_proven_bridge_limit_failures AS
 SELECT h.*,receipt.receipt_sha256 AS failure_receipt_sha256
 FROM district_pipeline.r1_subscription_usage_holds h
 JOIN district_pipeline.assessment_bridge_leases lease ON lease.id=h.bridge_lease_id AND lease.job_id=h.job_id
 JOIN district_pipeline.assessment_bridge_submission_intents intent ON intent.lease_id=lease.id AND intent.job_id=lease.job_id AND intent.run_id=lease.run_id AND intent.fencing_token=lease.fencing_token
 JOIN district_pipeline.executor_runs run ON run.id=lease.run_id AND run.authorization_id=h.authorization_id
 JOIN district_pipeline.step_receipts receipt ON receipt.job_id=lease.job_id AND receipt.run_id=lease.run_id AND receipt.fencing_token=lease.fencing_token
 WHERE h.provider='anthropic-subscription' AND h.no_output
  AND lease.state='held' AND lease.reason_code='budget_paused' AND lease.claimed_at IS NOT NULL AND h.observed_at>=lease.claimed_at
  AND run.state<>'running' AND receipt.outcome='held_execution' AND receipt.receipt->>'reasonCode'='budget_paused'
  AND receipt.receipt->'versions'->>'subscriptionLimitLeaseId'=lease.id::text
  AND receipt.receipt->'versions'->>'subscriptionLimitNoOutput'='true'
  AND h.failure_proof->>'version'='omp-provider-limit-failure-v1' AND h.failure_proof->>'exitCode'='0'
  AND h.failure_proof->>'terminalFrame'='assistant_turn_agent_error'
  AND receipt.receipt->'versions'->>'subscriptionLimitExitCode'=h.failure_proof->>'exitCode'
  AND receipt.receipt->'versions'->>'subscriptionLimitTerminalFrame'=h.failure_proof->>'terminalFrame'
  AND receipt.receipt->'versions'->>'subscriptionLimitStreamSha256'=h.failure_proof->>'streamSha256'
  AND receipt.receipt->'versions'->>'subscriptionLimitTerminalMessageSha256'=h.failure_proof->>'terminalMessageSha256'
  AND NOT EXISTS(SELECT 1 FROM district_pipeline.assessment_bridge_submissions submission WHERE submission.lease_id=lease.id);
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
   SELECT 1 FROM district_pipeline.r1_proven_bridge_limit_failures h
   JOIN district_pipeline.r1_subscription_resumptions disposition ON disposition.hold_id=h.id AND disposition.job_id=NEW.job_id AND disposition.prior_receipt_sha256=h.failure_receipt_sha256
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

-- An explicit lead decision, NOT evidence of completion or a refund. Existing
-- intents, receipts, jobs, usage holds and document limits are never rewritten.
CREATE TABLE district_pipeline.r1_codex_unsettled_retries (
 record_sha256 text PRIMARY KEY CHECK (record_sha256 ~ '^[a-f0-9]{64}$'),
 record_id text NOT NULL UNIQUE,
 record_bytes bytea NOT NULL CHECK (octet_length(record_bytes) BETWEEN 1 AND 2097152),
 intent_id uuid NOT NULL UNIQUE REFERENCES district_pipeline.r1_codex_call_intents(id),
 job_id uuid NOT NULL REFERENCES district_pipeline.jobs(id),
 held_receipt_id uuid NOT NULL REFERENCES district_pipeline.step_receipts(id),
 held_receipt_sha256 text NOT NULL CHECK (held_receipt_sha256 ~ '^[a-f0-9]{64}$'),
 original_sha256 text NOT NULL REFERENCES district_pipeline.r1_codex_documents(original_sha256),
 request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
 run_id uuid NOT NULL REFERENCES district_pipeline.executor_runs(id),
 authorization_id uuid NOT NULL REFERENCES district_pipeline.preauthorizations(id),
 prior_attempt integer NOT NULL CHECK (prior_attempt > 0),
 allowed_attempt integer NOT NULL CHECK (allowed_attempt = prior_attempt + 1),
 completion_state text NOT NULL CHECK (completion_state = 'completion_unknown'),
 action text NOT NULL CHECK (action = 'bounded_retry'),
 issued_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
 committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE district_pipeline.r1_codex_unsettled_retry_intents (
 disposition_sha256 text PRIMARY KEY REFERENCES district_pipeline.r1_codex_unsettled_retries(record_sha256),
 replacement_intent_id uuid NOT NULL UNIQUE REFERENCES district_pipeline.r1_codex_call_intents(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION district_pipeline.guard_codex_unsettled_retry_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(18441,81);
 IF NOT EXISTS (
  SELECT 1 FROM district_pipeline.r1_codex_unsettled_retries d
  JOIN district_pipeline.r1_codex_call_intents prior ON prior.id=d.intent_id
  JOIN district_pipeline.r1_codex_call_intents replacement ON replacement.id=NEW.replacement_intent_id
  JOIN district_pipeline.jobs j ON j.id=d.job_id
  JOIN district_pipeline.executor_runs r ON r.id=j.lease_owner
  JOIN district_pipeline.preauthorizations a ON a.id=r.authorization_id
  WHERE d.record_sha256=NEW.disposition_sha256
   AND prior.job_id=d.job_id AND prior.original_sha256=d.original_sha256 AND prior.request_sha256=d.request_sha256
   AND replacement.job_id=d.job_id AND replacement.original_sha256=d.original_sha256 AND replacement.request_sha256=d.request_sha256
   AND replacement.id<>prior.id AND replacement.paid_micro_usd=0 AND replacement.stage=prior.stage
   AND replacement.fencing_token=j.fencing_token AND j.attempt=d.allowed_attempt
   AND j.state='leased' AND NOT j.cancellation_requested AND j.lease_expires_at>clock_timestamp()
   AND r.state='running' AND a.state='approved' AND a.expires_at>clock_timestamp()
   AND d.issued_at<=clock_timestamp() AND clock_timestamp()<d.expires_at
   AND (SELECT count(*) FROM district_pipeline.r1_codex_call_intents WHERE original_sha256=d.original_sha256)<=48
 ) THEN RAISE EXCEPTION 'Invalid bounded Codex unsettled retry consumption'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_codex_unsettled_retry_intent BEFORE INSERT ON district_pipeline.r1_codex_unsettled_retry_intents FOR EACH ROW EXECUTE FUNCTION district_pipeline.guard_codex_unsettled_retry_intent();
CREATE TRIGGER codex_unsettled_retry_immutable BEFORE UPDATE OR DELETE ON district_pipeline.r1_codex_unsettled_retries FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
CREATE TRIGGER codex_unsettled_retry_intent_immutable BEFORE UPDATE OR DELETE ON district_pipeline.r1_codex_unsettled_retry_intents FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();

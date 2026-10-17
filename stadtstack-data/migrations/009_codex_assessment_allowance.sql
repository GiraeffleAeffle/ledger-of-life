-- Operational A/C allowance attribution only. The original stored base stays48.
-- Ordinals are lifetime positions, never reset by a new approval or failed call.
CREATE TABLE district_pipeline.r1_codex_allowance_intents (
 intent_id uuid PRIMARY KEY REFERENCES district_pipeline.r1_codex_call_intents(id),
 original_sha256 text NOT NULL REFERENCES district_pipeline.r1_codex_documents(original_sha256),
 allowance_sha256 text NOT NULL CHECK (allowance_sha256 ~ '^[a-f0-9]{64}$'),
 cohort_sha256 text NOT NULL CHECK (cohort_sha256 ~ '^[a-f0-9]{64}$'),
 queue_contract_sha256 text NOT NULL CHECK (queue_contract_sha256 ~ '^[a-f0-9]{64}$'),
 original_extra_ordinal integer NOT NULL CHECK (original_extra_ordinal BETWEEN 1 AND 24),
 cohort_extra_ordinal integer NOT NULL CHECK (cohort_extra_ordinal BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(original_sha256,original_extra_ordinal),
 UNIQUE(cohort_sha256,cohort_extra_ordinal)
);
CREATE FUNCTION district_pipeline.guard_r1_codex_allowance_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(18441,81);
 IF NOT EXISTS (
  SELECT 1 FROM district_pipeline.r1_codex_call_intents i
  JOIN district_pipeline.jobs j ON j.id=i.job_id
  JOIN district_pipeline.r1_codex_documents d ON d.original_sha256=i.original_sha256 AND d.max_calls=48
  JOIN district_pipeline.r1_codex_call_authorizations a ON a.intent_id=i.id
  WHERE i.id=NEW.intent_id AND i.original_sha256=NEW.original_sha256
   AND i.stage IN ('assessment_a','assessment_c') AND j.step=i.stage
   AND i.paid_micro_usd=0 AND j.semantic_contract_sha256=NEW.queue_contract_sha256
   AND j.spec->>'semanticContractSha256'=NEW.queue_contract_sha256
 ) THEN RAISE EXCEPTION 'Invalid R1 Codex allowance intent binding'; END IF;
 IF (SELECT count(*) FROM district_pipeline.r1_codex_call_intents WHERE original_sha256=NEW.original_sha256)<>48+NEW.original_extra_ordinal
  OR (SELECT count(*) FROM district_pipeline.r1_codex_allowance_intents WHERE original_sha256=NEW.original_sha256)<>NEW.original_extra_ordinal-1
  OR (SELECT count(*) FROM district_pipeline.r1_codex_allowance_intents WHERE cohort_sha256=NEW.cohort_sha256)<>NEW.cohort_extra_ordinal-1
 THEN RAISE EXCEPTION 'Invalid R1 Codex lifetime allowance position'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_r1_codex_allowance_intent BEFORE INSERT ON district_pipeline.r1_codex_allowance_intents FOR EACH ROW EXECUTE FUNCTION district_pipeline.guard_r1_codex_allowance_intent();
CREATE TRIGGER r1_codex_allowance_intent_immutable BEFORE UPDATE OR DELETE ON district_pipeline.r1_codex_allowance_intents FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();

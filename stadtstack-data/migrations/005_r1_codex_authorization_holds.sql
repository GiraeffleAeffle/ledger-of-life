-- Usage limits stop the current authorization; only a later explicit authorization resumes.
CREATE OR REPLACE FUNCTION district_pipeline.pin_r1_codex_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.original_sha256 IS DISTINCT FROM OLD.original_sha256 OR NEW.max_calls>OLD.max_calls THEN
  RAISE EXCEPTION 'Immutable R1 Codex accounting bounds';
 END IF;
 RETURN NEW;
END $$;
ALTER TABLE district_pipeline.r1_codex_documents DROP COLUMN paused;
ALTER TABLE district_pipeline.r1_codex_call_intents DROP CONSTRAINT r1_codex_call_intents_job_id_request_sha256_key;
ALTER TABLE district_pipeline.r1_codex_call_intents ADD UNIQUE(job_id,request_sha256,fencing_token);
CREATE TABLE district_pipeline.r1_codex_call_authorizations (
 intent_id uuid PRIMARY KEY REFERENCES district_pipeline.r1_codex_call_intents(id),
 authorization_id uuid NOT NULL REFERENCES district_pipeline.preauthorizations(id),
 run_id uuid NOT NULL REFERENCES district_pipeline.executor_runs(id)
);
CREATE TABLE district_pipeline.r1_codex_usage_holds (
 authorization_id uuid PRIMARY KEY REFERENCES district_pipeline.preauthorizations(id),
 run_id uuid NOT NULL REFERENCES district_pipeline.executor_runs(id),
 failed_intent_id uuid NOT NULL REFERENCES district_pipeline.r1_codex_call_intents(id),
 held_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE district_pipeline.r1_codex_resumptions (
 held_authorization_id uuid NOT NULL REFERENCES district_pipeline.r1_codex_usage_holds(authorization_id),
 authorization_id uuid NOT NULL REFERENCES district_pipeline.preauthorizations(id),
 run_id uuid NOT NULL REFERENCES district_pipeline.executor_runs(id),
 approval_sha256 text NOT NULL CHECK (approval_sha256 ~ '^[a-f0-9]{64}$'),
 approved_by text NOT NULL,
 approved_at timestamptz NOT NULL,
 resumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(held_authorization_id,authorization_id),
 CHECK(held_authorization_id<>authorization_id)
);
CREATE TRIGGER r1_codex_call_authorization_immutable BEFORE UPDATE OR DELETE ON district_pipeline.r1_codex_call_authorizations FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
CREATE TRIGGER r1_codex_usage_hold_immutable BEFORE UPDATE OR DELETE ON district_pipeline.r1_codex_usage_holds FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
CREATE TRIGGER r1_codex_resumption_immutable BEFORE UPDATE OR DELETE ON district_pipeline.r1_codex_resumptions FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();

-- #81 cumulative accounting. Intents count even after ambiguous/failed effects.
CREATE TABLE district_pipeline.r1_codex_documents (
 original_sha256 text PRIMARY KEY CHECK (original_sha256 ~ '^[a-f0-9]{64}$'),
 max_calls integer NOT NULL CHECK (max_calls BETWEEN 2 AND 48),
 paused boolean NOT NULL DEFAULT false
);
CREATE TABLE district_pipeline.r1_codex_selections (
 municipality_id text NOT NULL,
 original_sha256 text NOT NULL REFERENCES district_pipeline.r1_codex_documents(original_sha256),
 PRIMARY KEY (municipality_id,original_sha256)
);
CREATE TABLE district_pipeline.r1_codex_call_intents (
 id uuid PRIMARY KEY,
 original_sha256 text NOT NULL REFERENCES district_pipeline.r1_codex_documents(original_sha256),
 job_id uuid NOT NULL REFERENCES district_pipeline.jobs(id),
 fencing_token bigint NOT NULL,
 request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
 stage text NOT NULL CHECK (stage IN ('residual_extract','assessment_a','assessment_c')),
 paid_micro_usd bigint NOT NULL DEFAULT 0 CHECK (paid_micro_usd=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(job_id,request_sha256)
);
CREATE TRIGGER r1_codex_intent_immutable BEFORE UPDATE OR DELETE ON district_pipeline.r1_codex_call_intents FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
CREATE TRIGGER r1_codex_selection_immutable BEFORE UPDATE OR DELETE ON district_pipeline.r1_codex_selections FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();
CREATE FUNCTION district_pipeline.pin_r1_codex_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.original_sha256 IS DISTINCT FROM OLD.original_sha256 OR NEW.max_calls>OLD.max_calls OR (OLD.paused AND NOT NEW.paused) THEN
  RAISE EXCEPTION 'Immutable R1 Codex accounting bounds';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pin_r1_codex_document BEFORE UPDATE ON district_pipeline.r1_codex_documents FOR EACH ROW EXECUTE FUNCTION district_pipeline.pin_r1_codex_document();
CREATE TRIGGER retain_r1_codex_document BEFORE DELETE ON district_pipeline.r1_codex_documents FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();

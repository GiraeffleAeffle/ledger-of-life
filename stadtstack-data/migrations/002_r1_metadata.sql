-- Canonical safe operator metadata survives removal of private CAS duplicates.
-- Operator callers validate the real schema, then hash canonicalJson(payload).
-- No source originals or private provider responses belong in this table.
-- Applied 001 remains untouched; the ordered runner pins this file separately.
CREATE TABLE district_pipeline.r1_metadata_snapshots (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('structured_run','records','coverage','registry','routes','acquisition_descriptor','http_observation','replay_artifact','replay_proof')),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) IN ('object','array')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX r1_metadata_snapshot_kind ON district_pipeline.r1_metadata_snapshots(kind,created_at);
CREATE TRIGGER immutable_r1_metadata_snapshots BEFORE UPDATE OR DELETE ON district_pipeline.r1_metadata_snapshots
FOR EACH ROW EXECUTE FUNCTION district_pipeline.immutable_row();

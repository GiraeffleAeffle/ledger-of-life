-- Existing migrations remain byte-pinned; apply this before concurrent runners.
DROP INDEX district_pipeline.one_running_r1_executor;
CREATE TABLE district_pipeline.resource_slots (
  resource text NOT NULL CHECK(resource IN ('codex-subscription','omp-b')),
  job_id uuid NOT NULL REFERENCES district_pipeline.jobs(id),
  slot_limit integer NOT NULL CHECK(slot_limit BETWEEN 1 AND 64),
  fencing_token bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(resource,job_id)
);
CREATE INDEX resource_slots_expiry ON district_pipeline.resource_slots(resource,expires_at);
ALTER TABLE district_pipeline.owner_notifications ADD COLUMN claim_token uuid, ADD COLUMN claim_expires_at timestamptz;
ALTER TABLE district_pipeline.owner_notifications ADD CONSTRAINT notification_claim_pair CHECK((claim_token IS NULL)=(claim_expires_at IS NULL));
CREATE OR REPLACE FUNCTION district_pipeline.pin_owner_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['state','attempts','delivered_at','provider','provider_message_id','acknowledged_at','claim_token','claim_expires_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','attempts','delivered_at','provider','provider_message_id','acknowledged_at','claim_token','claim_expires_at'])
    OR NEW.attempts<OLD.attempts OR (OLD.state='delivered' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
  THEN RAISE EXCEPTION 'Notification payload and delivered acknowledgement are immutable'; END IF;
  RETURN NEW;
END $$;

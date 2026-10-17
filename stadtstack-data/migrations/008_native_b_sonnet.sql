-- Add native Sonnet B without rewriting immutable historical Haiku identities.
ALTER TABLE district_pipeline.assessment_bridge_leases
  DROP CONSTRAINT assessment_bridge_leases_requested_model_check,
  ADD CONSTRAINT assessment_bridge_leases_requested_model_check
    CHECK (requested_model IN ('claude-haiku-5-5','claude-sonnet-5-5'));

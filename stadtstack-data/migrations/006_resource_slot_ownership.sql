-- An acquired resource obligation survives slot reclamation and process loss.
-- Waiting jobs legitimately have no obligation; renewal must not infer that a
-- disappeared slot means the handler never acquired one.
ALTER TABLE district_pipeline.jobs ADD COLUMN resource_slot_required text
  CHECK(resource_slot_required IN ('codex-subscription','omp-b'));

CREATE INDEX IF NOT EXISTS idx_segments_submitter_created
ON segments(submitter_hash, created_at DESC);

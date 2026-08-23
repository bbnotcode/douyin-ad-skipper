CREATE TABLE IF NOT EXISTS segment_revisions (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  editor_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('update', 'withdraw')),
  previous_start_ms INTEGER NOT NULL,
  previous_end_ms INTEGER NOT NULL,
  previous_category TEXT NOT NULL,
  next_start_ms INTEGER,
  next_end_ms INTEGER,
  next_category TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_segment_revisions_segment_created
ON segment_revisions(segment_id, created_at DESC);

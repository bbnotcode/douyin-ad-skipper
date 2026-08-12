CREATE TABLE IF NOT EXISTS segment_skips (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  viewer_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  seconds_saved INTEGER NOT NULL CHECK (seconds_saved > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, viewer_hash, day)
);

CREATE INDEX IF NOT EXISTS idx_segment_skips_segment
ON segment_skips(segment_id);

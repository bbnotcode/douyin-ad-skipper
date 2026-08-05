PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
  duration_ms INTEGER,
  category TEXT NOT NULL DEFAULT 'sponsor' CHECK (category IN ('sponsor')),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'trusted', 'disputed', 'rejected')),
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  submitter_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_segments_video_status ON segments(video_id, status, start_ms);

CREATE TABLE IF NOT EXISTS votes (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  voter_hash TEXT NOT NULL,
  vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, voter_hash)
);

CREATE TABLE IF NOT EXISTS reports (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  reporter_hash TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('wrong_video', 'wrong_time', 'not_ad', 'abuse', 'other')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, reporter_hash)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  identity_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (identity_hash, action, bucket)
);

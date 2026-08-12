PRAGMA defer_foreign_keys = ON;

CREATE TABLE segments_new (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
  duration_ms INTEGER,
  category TEXT NOT NULL DEFAULT 'sponsor' CHECK (category IN ('sponsor', 'selfpromo', 'interaction')),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'trusted', 'disputed', 'rejected')),
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  submitter_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  video_hash TEXT
);

INSERT INTO segments_new
SELECT id, video_id, start_ms, end_ms, duration_ms, category, status, upvotes, downvotes,
  submitter_hash, created_at, updated_at, video_hash
FROM segments;

CREATE TABLE votes_new (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  voter_hash TEXT NOT NULL,
  vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, voter_hash)
);
INSERT INTO votes_new SELECT * FROM votes;

CREATE TABLE reports_new (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  reporter_hash TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('wrong_video', 'wrong_time', 'not_ad', 'abuse', 'other')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, reporter_hash)
);
INSERT INTO reports_new SELECT * FROM reports;

CREATE TABLE segment_skips_new (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  viewer_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  seconds_saved INTEGER NOT NULL CHECK (seconds_saved > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, viewer_hash, day)
);
INSERT INTO segment_skips_new SELECT * FROM segment_skips;

DROP TABLE segment_skips;
DROP TABLE reports;
DROP TABLE votes;
DROP TABLE segments;

ALTER TABLE segments_new RENAME TO segments;
ALTER TABLE votes_new RENAME TO votes;
ALTER TABLE reports_new RENAME TO reports;
ALTER TABLE segment_skips_new RENAME TO segment_skips;

CREATE INDEX idx_segments_video_status ON segments(video_id, status, start_ms);
CREATE INDEX idx_segments_submitter_created ON segments(submitter_hash, created_at DESC);
CREATE INDEX idx_segments_video_hash_status ON segments(video_hash, status, start_ms);
CREATE INDEX idx_segment_skips_segment ON segment_skips(segment_id);

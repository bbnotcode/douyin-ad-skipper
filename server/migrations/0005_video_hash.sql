ALTER TABLE segments ADD COLUMN video_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_segments_video_hash_status
ON segments(video_hash, status, start_ms);

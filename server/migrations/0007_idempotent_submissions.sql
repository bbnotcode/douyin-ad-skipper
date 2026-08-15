ALTER TABLE segments ADD COLUMN client_request_id TEXT;

-- Legacy rows keep NULL, while every new request is unique for its anonymous contributor.
-- SQLite permits multiple NULL values in a UNIQUE index, so this is safe for existing data.
CREATE UNIQUE INDEX IF NOT EXISTS idx_segments_submitter_request
ON segments(submitter_hash, client_request_id);

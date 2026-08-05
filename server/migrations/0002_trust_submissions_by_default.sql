UPDATE segments
SET status = 'trusted', updated_at = CURRENT_TIMESTAMP
WHERE status = 'candidate';

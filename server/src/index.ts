import {
  REPORT_REASONS,
  VIDEO_ID_PATTERN,
  clusterSegments,
  parseSegmentInput,
  parseSegmentRevisionInput,
  segmentsAreSimilar,
  statusFromVotes,
} from './validation.ts';

interface Env {
  DB: D1Database;
  CLIENT_HASH_SALT?: string;
}

type SegmentRow = {
  id: string; video_id: string; start_ms: number; end_ms: number; category: string;
  status: string; upvotes: number; downvotes: number; created_at: string; updated_at?: string;
  duration_ms?: number | null;
};

type OwnedSegmentRow = SegmentRow & { owned_by_me: number };
type SubmitterSegmentRow = SegmentRow & { submitter_hash: string };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Client-ID',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'X-Content-Type-Options': 'nosniff',
};
const MAX_JSON_BODY_BYTES = 8 * 1024;
const BODY_TOO_LARGE = Symbol('body_too_large');

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...CORS, 'Cache-Control': 'no-store', ...extra } });
}

async function bodyJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) return null;
  const declaredSize = Number(request.headers.get('content-length') || 0);
  if (declaredSize > MAX_JSON_BODY_BYTES) return BODY_TOO_LARGE;
  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_JSON_BODY_BYTES) return BODY_TOO_LARGE;
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function clientIdFrom(request: Request): string {
  return request.headers.get('X-Client-ID') || '';
}

async function contributorHash(request: Request, env: Env): Promise<string | null> {
  if (!env.CLIENT_HASH_SALT) return null;
  const clientId = clientIdFrom(request);
  if (!/^[0-9a-f-]{16,64}$/i.test(clientId)) return '';
  return sha256(`${env.CLIENT_HASH_SALT}:contributor:${clientId}`);
}

async function rateIdentityHash(request: Request, env: Env): Promise<string | null> {
  const contributor = await contributorHash(request, env);
  if (!contributor) return contributor;
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  return sha256(`${env.CLIENT_HASH_SALT}:rate:${contributor}:${ip}`);
}

async function ipRateIdentityHash(request: Request, env: Env): Promise<string | null> {
  if (!env.CLIENT_HASH_SALT) return null;
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  return sha256(`${env.CLIENT_HASH_SALT}:rate-ip:${ip}`);
}

async function allowedWriteRate(request: Request, env: Env, action: string, identityLimit: number, ipLimit: number): Promise<boolean> {
  const identity = await rateIdentityHash(request, env);
  const ipIdentity = await ipRateIdentityHash(request, env);
  return Boolean(identity && ipIdentity &&
    await withinRateLimit(env, identity, action, identityLimit) &&
    await withinRateLimit(env, ipIdentity, `${action}:ip`, ipLimit));
}

async function migrateLegacyIdentity(request: Request, env: Env, stableHash: string): Promise<void> {
  const clientId = clientIdFrom(request);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const legacyHash = await sha256(`${env.CLIENT_HASH_SALT}:${clientId}:${ip}`);
  if (legacyHash !== stableHash) {
    await env.DB.prepare('UPDATE segments SET submitter_hash = ? WHERE submitter_hash = ?')
      .bind(stableHash, legacyHash).run();
  }
}

async function withinRateLimit(env: Env, identity: string, action: string, limit: number): Promise<boolean> {
  const bucket = new Date().toISOString().slice(0, 13);
  const row = await env.DB.prepare(`
    INSERT INTO rate_limits (identity_hash, action, bucket, count) VALUES (?, ?, ?, 1)
    ON CONFLICT(identity_hash, action, bucket) DO UPDATE SET count = count + 1
    RETURNING count
  `).bind(identity, action, bucket).first<{ count: number }>();
  const sample = new Uint8Array(1);
  crypto.getRandomValues(sample);
  if (sample[0] === 0) {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 13);
    await env.DB.prepare('DELETE FROM rate_limits WHERE bucket < ?').bind(cutoff).run();
  }
  return Boolean(row && row.count <= limit);
}

export function segmentJson(row: SegmentRow, ownedByMe?: boolean, cluster?: { clusterSize: number }) {
  const segment = {
    id: row.id, videoId: row.video_id, start: row.start_ms / 1000, end: row.end_ms / 1000,
    category: row.category, status: row.status, upvotes: row.upvotes, downvotes: row.downvotes,
    score: row.upvotes + row.downvotes ? row.upvotes / (row.upvotes + row.downvotes) : 0,
    createdAt: row.created_at, updatedAt: row.updated_at || row.created_at,
    ...(cluster && cluster.clusterSize > 1 ? cluster : {}),
  };
  return ownedByMe === undefined ? segment : { ...segment, ownedByMe };
}

async function getSegments(videoId: string, env: Env): Promise<Response> {
  if (!VIDEO_ID_PATTERN.test(videoId)) return json({ error: 'invalid_video_id' }, 400);
  const videoHash = await sha256(videoId);
  await env.DB.prepare('UPDATE segments SET video_hash = ? WHERE video_id = ? AND video_hash IS NULL')
    .bind(videoHash, videoId).run();
  const result = await env.DB.prepare(`
    SELECT id, video_id, start_ms, end_ms, category, status, upvotes, downvotes, created_at, updated_at
    FROM segments WHERE video_id = ? AND status IN ('candidate', 'trusted') ORDER BY start_ms ASC LIMIT 200
  `).bind(videoId).all<SegmentRow>();
  const clusters = clusterSegments(result.results);
  return json({ videoId, segments: clusters.map((row) => segmentJson(row, undefined, { clusterSize: row.clusterSize })) });
}

async function getSegmentsByHash(request: Request, videoHash: string, env: Env): Promise<Response> {
  if (!/^[0-9a-f]{64}$/i.test(videoHash)) return json({ error: 'invalid_video_hash' }, 400);
  const identity = await contributorHash(request, env);
  const ownershipIdentity = identity || '';
  const result = await env.DB.prepare(`
    SELECT id, video_id, start_ms, end_ms, category, status, upvotes, downvotes, created_at, updated_at,
      CASE WHEN ? != '' AND submitter_hash = ? THEN 1 ELSE 0 END AS owned_by_me
    FROM segments WHERE video_hash = ? AND status IN ('candidate', 'trusted') ORDER BY start_ms ASC LIMIT 200
  `).bind(ownershipIdentity, ownershipIdentity, videoHash.toLowerCase()).all<OwnedSegmentRow>();
  const segments = clusterSegments(result.results).map((row) => {
    const { videoId: _videoId, ...segment } = segmentJson(row);
    return {
      ...segment,
      ownedByMe: Boolean(row.owned_by_me),
      ...(row.clusterSize > 1 ? { clusterSize: row.clusterSize } : {}),
    };
  });
  return json({ segments });
}

async function getMySegments(request: Request, env: Env): Promise<Response> {
  const identity = await contributorHash(request, env);
  if (identity === null) return json({ error: 'writes_not_configured' }, 503);
  if (!identity) return json({ error: 'invalid_client_id' }, 400);
  await migrateLegacyIdentity(request, env, identity);
  const result = await env.DB.prepare(`
    SELECT id, video_id, start_ms, end_ms, duration_ms, category, status, upvotes, downvotes, created_at, updated_at
    FROM segments WHERE submitter_hash = ? AND status != 'rejected'
    ORDER BY created_at DESC LIMIT 500
  `).bind(identity).all<SegmentRow>();
  const contributedMs = result.results.reduce((sum, row) => sum + Math.max(0, row.end_ms - row.start_ms), 0);
  const impact = await env.DB.prepare(`
    SELECT COUNT(*) AS skip_count, COUNT(DISTINCT skips.viewer_hash) AS helped_people,
      COALESCE(SUM(skips.seconds_saved), 0) AS seconds_saved
    FROM segment_skips AS skips
    INNER JOIN segments ON segments.id = skips.segment_id
    WHERE segments.submitter_hash = ? AND segments.status != 'rejected'
  `).bind(identity).first<{ skip_count: number; helped_people: number; seconds_saved: number }>();
  return json({
    segments: result.results.map((row) => segmentJson(row)),
    stats: {
      submittedCount: result.results.length,
      contributedSeconds: contributedMs / 1000,
      skipCount: Number(impact?.skip_count || 0),
      helpedPeople: Number(impact?.helped_people || 0),
      secondsSaved: Number(impact?.seconds_saved || 0),
      receivedUpvotes: result.results.reduce((sum, row) => sum + Number(row.upvotes || 0), 0),
      receivedDownvotes: result.results.reduce((sum, row) => sum + Number(row.downvotes || 0), 0),
      disputedCount: result.results.filter((row) => row.status === 'disputed').length,
    },
  });
}

async function recordSegmentSkip(request: Request, env: Env, segmentId: string): Promise<Response> {
  const viewer = await contributorHash(request, env);
  if (viewer === null) return json({ error: 'writes_not_configured' }, 503);
  if (!viewer) return json({ error: 'invalid_client_id' }, 400);
  if (!await allowedWriteRate(request, env, 'skip', 300, 2000)) return json({ error: 'rate_limited' }, 429);
  const segment = await env.DB.prepare(`
    SELECT start_ms, end_ms, submitter_hash FROM segments
    WHERE id = ? AND status = 'trusted'
  `).bind(segmentId).first<{ start_ms: number; end_ms: number; submitter_hash: string }>();
  if (!segment) return json({ error: 'segment_not_found' }, 404);
  if (segment.submitter_hash === viewer) return json({ recorded: false, reason: 'own_segment' });
  const secondsSaved = Math.max(1, Math.round((segment.end_ms - segment.start_ms) / 1000));
  const day = new Date().toISOString().slice(0, 10);
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO segment_skips (segment_id, viewer_hash, day, seconds_saved, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(segmentId, viewer, day, secondsSaved, new Date().toISOString()).run();
  return json({ recorded: Number(result.meta.changes || 0) > 0, secondsSaved });
}

async function submitSegment(request: Request, env: Env): Promise<Response> {
  const identity = await contributorHash(request, env);
  if (identity === null) return json({ error: 'writes_not_configured' }, 503);
  if (!identity) return json({ error: 'invalid_client_id' }, 400);
  if (!await allowedWriteRate(request, env, 'submit', 20, 100)) return json({ error: 'rate_limited' }, 429);
  await migrateLegacyIdentity(request, env, identity);
  const body = await bodyJson(request);
  if (body === BODY_TOO_LARGE) return json({ error: 'payload_too_large' }, 413);
  const input = parseSegmentInput(body);
  if (!input) return json({ error: 'invalid_segment' }, 400);
  const startMs = Math.round(input.start * 1000), endMs = Math.round(input.end * 1000);
  const idempotent = await env.DB.prepare(`
    SELECT id, video_id, start_ms, end_ms, category, status, upvotes, downvotes, created_at
    FROM segments WHERE submitter_hash = ? AND client_request_id = ? LIMIT 1
  `).bind(identity, input.clientRequestId).first<SegmentRow>();
  if (idempotent) return json({ segment: segmentJson(idempotent, true), duplicate: true, idempotent: true });
  const candidates = await env.DB.prepare(`
    SELECT id, video_id, start_ms, end_ms, category, status, upvotes, downvotes, created_at, submitter_hash FROM segments
    WHERE video_id = ? AND category = ? AND status != 'rejected'
      AND end_ms >= ? AND start_ms <= ?
    ORDER BY start_ms ASC LIMIT 50
  `).bind(input.videoId, input.category, startMs - 3000, endMs + 3000).all<SubmitterSegmentRow>();
  const comparison = { id: '', start_ms: startMs, end_ms: endMs, category: input.category, status: 'trusted', upvotes: 0, downvotes: 0 };
  const existing = candidates.results.find((row) => segmentsAreSimilar(row, comparison));
  if (existing) return json({ segment: segmentJson(existing, existing.submitter_hash === identity), duplicate: true });
  const id = crypto.randomUUID(), now = new Date().toISOString();
  const videoHash = await sha256(input.videoId);
  const inserted = await env.DB.prepare(`
    INSERT INTO segments (
      id, video_id, video_hash, start_ms, end_ms, duration_ms, category, status,
      submitter_hash, client_request_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'trusted', ?, ?, ?, ?)
    ON CONFLICT(submitter_hash, client_request_id) DO UPDATE SET
      client_request_id = excluded.client_request_id
    RETURNING id, video_id, start_ms, end_ms, category, status, upvotes, downvotes, created_at
  `).bind(
    id, input.videoId, videoHash, startMs, endMs,
    input.duration == null ? null : Math.round(input.duration * 1000),
    input.category, identity, input.clientRequestId, now, now,
  ).first<SegmentRow>();
  if (!inserted) throw new Error('segment_insert_returned_no_row');
  if (inserted.id !== id) {
    return json({ segment: segmentJson(inserted, true), duplicate: true, idempotent: true });
  }
  return json({ segment: segmentJson(inserted, true), duplicate: false, idempotent: false }, 201);
}

async function updateOwnSegment(request: Request, env: Env, segmentId: string): Promise<Response> {
  const identity = await contributorHash(request, env);
  if (identity === null) return json({ error: 'writes_not_configured' }, 503);
  if (!identity) return json({ error: 'invalid_client_id' }, 400);
  if (!await allowedWriteRate(request, env, 'edit', 20, 100)) return json({ error: 'rate_limited' }, 429);
  const current = await env.DB.prepare(`
    SELECT id, video_id, start_ms, end_ms, duration_ms, category, status, upvotes, downvotes, created_at, updated_at
    FROM segments WHERE id = ? AND submitter_hash = ? AND status != 'rejected'
  `).bind(segmentId, identity).first<SegmentRow>();
  if (!current) return json({ error: 'segment_not_found_or_not_owned' }, 404);
  const body = await bodyJson(request);
  if (body === BODY_TOO_LARGE) return json({ error: 'payload_too_large' }, 413);
  const input = parseSegmentRevisionInput(body);
  if (!input) return json({ error: 'invalid_segment_revision' }, 400);
  const startMs = Math.round(input.start * 1000), endMs = Math.round(input.end * 1000);
  const candidates = await env.DB.prepare(`
    SELECT id, video_id, start_ms, end_ms, category, status, upvotes, downvotes, created_at, submitter_hash
    FROM segments WHERE video_id = ? AND category = ? AND id != ? AND status != 'rejected'
      AND end_ms >= ? AND start_ms <= ? ORDER BY start_ms ASC LIMIT 50
  `).bind(current.video_id, input.category, segmentId, startMs - 3000, endMs + 3000).all<SubmitterSegmentRow>();
  const comparison = { id: segmentId, start_ms: startMs, end_ms: endMs, category: input.category, status: 'trusted', upvotes: 0, downvotes: 0 };
  const duplicate = candidates.results.find((row) => segmentsAreSimilar(row, comparison));
  if (duplicate) return json({ error: 'similar_segment_exists', segment: segmentJson(duplicate, duplicate.submitter_hash === identity) }, 409);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO segment_revisions (
      id, segment_id, editor_hash, action, previous_start_ms, previous_end_ms, previous_category,
      next_start_ms, next_end_ms, next_category, created_at
    ) VALUES (?, ?, ?, 'update', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), segmentId, identity, current.start_ms, current.end_ms, current.category, startMs, endMs, input.category, now),
    env.DB.prepare(`UPDATE segments SET start_ms = ?, end_ms = ?, duration_ms = ?, category = ?,
      status = 'trusted', upvotes = 0, downvotes = 0, updated_at = ? WHERE id = ?`)
      .bind(startMs, endMs, input.duration == null ? current.duration_ms ?? null : Math.round(input.duration * 1000), input.category, now, segmentId),
    env.DB.prepare('DELETE FROM votes WHERE segment_id = ?').bind(segmentId),
    env.DB.prepare('DELETE FROM reports WHERE segment_id = ?').bind(segmentId),
    env.DB.prepare('DELETE FROM segment_skips WHERE segment_id = ?').bind(segmentId),
  ]);
  const updated = { ...current, start_ms: startMs, end_ms: endMs, category: input.category, status: 'trusted', upvotes: 0, downvotes: 0, updated_at: now };
  return json({ segment: segmentJson(updated, true), resetFeedback: true });
}

async function withdrawOwnSegment(request: Request, env: Env, segmentId: string): Promise<Response> {
  const identity = await contributorHash(request, env);
  if (identity === null) return json({ error: 'writes_not_configured' }, 503);
  if (!identity) return json({ error: 'invalid_client_id' }, 400);
  if (!await allowedWriteRate(request, env, 'withdraw', 20, 100)) return json({ error: 'rate_limited' }, 429);
  const current = await env.DB.prepare(`
    SELECT id, video_id, start_ms, end_ms, duration_ms, category, status, upvotes, downvotes, created_at, updated_at
    FROM segments WHERE id = ? AND submitter_hash = ? AND status != 'rejected'
  `).bind(segmentId, identity).first<SegmentRow>();
  if (!current) return json({ error: 'segment_not_found_or_not_owned' }, 404);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO segment_revisions (
      id, segment_id, editor_hash, action, previous_start_ms, previous_end_ms, previous_category, created_at
    ) VALUES (?, ?, ?, 'withdraw', ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), segmentId, identity, current.start_ms, current.end_ms, current.category, now),
    env.DB.prepare("UPDATE segments SET status = 'rejected', updated_at = ? WHERE id = ?").bind(now, segmentId),
    env.DB.prepare('DELETE FROM votes WHERE segment_id = ?').bind(segmentId),
    env.DB.prepare('DELETE FROM reports WHERE segment_id = ?').bind(segmentId),
    env.DB.prepare('DELETE FROM segment_skips WHERE segment_id = ?').bind(segmentId),
  ]);
  return json({ id: segmentId, withdrawn: true });
}

async function vote(request: Request, env: Env, segmentId: string): Promise<Response> {
  const identity = await contributorHash(request, env);
  if (identity === null) return json({ error: 'writes_not_configured' }, 503);
  if (!identity) return json({ error: 'invalid_client_id' }, 400);
  if (!await allowedWriteRate(request, env, 'vote', 60, 300)) return json({ error: 'rate_limited' }, 429);
  const body = await bodyJson(request) as { vote?: unknown } | null | typeof BODY_TOO_LARGE;
  if (body === BODY_TOO_LARGE) return json({ error: 'payload_too_large' }, 413);
  const value = Number(body?.vote);
  if (value !== 1 && value !== -1) return json({ error: 'invalid_vote' }, 400);
  const exists = await env.DB.prepare('SELECT id, submitter_hash FROM segments WHERE id = ?').bind(segmentId).first<{id:string;submitter_hash:string}>();
  if (!exists) return json({ error: 'segment_not_found' }, 404);
  if (exists.submitter_hash === identity) return json({ error: 'cannot_vote_own_segment' }, 403);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO votes (segment_id, voter_hash, vote, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(segment_id, voter_hash) DO UPDATE SET vote = excluded.vote, updated_at = excluded.updated_at`
  ).bind(segmentId, identity, value, now, now).run();
  const counts = await env.DB.prepare(`SELECT
    COALESCE(SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
    COALESCE(SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END), 0) AS downvotes FROM votes WHERE segment_id = ?`
  ).bind(segmentId).first<{ upvotes: number; downvotes: number }>();
  const upvotes = Number(counts?.upvotes || 0), downvotes = Number(counts?.downvotes || 0);
  const status = statusFromVotes(upvotes, downvotes);
  await env.DB.prepare('UPDATE segments SET upvotes = ?, downvotes = ?, status = ?, updated_at = ? WHERE id = ?')
    .bind(upvotes, downvotes, status, now, segmentId).run();
  return json({ id: segmentId, upvotes, downvotes, status });
}

async function report(request: Request, env: Env, segmentId: string): Promise<Response> {
  const identity = await contributorHash(request, env);
  if (identity === null) return json({ error: 'writes_not_configured' }, 503);
  if (!identity) return json({ error: 'invalid_client_id' }, 400);
  if (!await allowedWriteRate(request, env, 'report', 10, 50)) return json({ error: 'rate_limited' }, 429);
  const body = await bodyJson(request) as { reason?: unknown } | null | typeof BODY_TOO_LARGE;
  if (body === BODY_TOO_LARGE) return json({ error: 'payload_too_large' }, 413);
  const reason = String(body?.reason || '');
  if (!REPORT_REASONS.has(reason)) return json({ error: 'invalid_reason' }, 400);
  const exists = await env.DB.prepare('SELECT id, submitter_hash FROM segments WHERE id = ?').bind(segmentId).first<{id:string;submitter_hash:string}>();
  if (!exists) return json({ error: 'segment_not_found' }, 404);
  if (exists.submitter_hash === identity) return json({ error: 'cannot_report_own_segment' }, 403);
  await env.DB.prepare(`INSERT INTO reports (segment_id, reporter_hash, reason, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(segment_id, reporter_hash) DO UPDATE SET reason = excluded.reason`
  ).bind(segmentId, identity, reason, new Date().toISOString()).run();
  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM reports WHERE segment_id = ?').bind(segmentId).first<{ count: number }>();
  if (Number(count?.count || 0) >= 3) await env.DB.prepare("UPDATE segments SET status = 'disputed', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), segmentId).run();
  return json({ id: segmentId, reports: Number(count?.count || 0) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url), path = url.pathname;
    try {
      if (request.method === 'GET' && path === '/health') return json({ ok: true, service: 'douyin-ad-skipper-api', version: 4 });
      const videoMatch = path.match(/^\/v1\/videos\/(\d+)\/segments$/);
      if (request.method === 'GET' && videoMatch) return getSegments(videoMatch[1], env);
      const videoHashMatch = path.match(/^\/v1\/videos\/by-hash\/([0-9a-f]{64})\/segments$/i);
      if (request.method === 'GET' && videoHashMatch) return getSegmentsByHash(request, videoHashMatch[1], env);
      if (request.method === 'GET' && path === '/v1/me/segments') return getMySegments(request, env);
      if (request.method === 'POST' && path === '/v1/segments') return submitSegment(request, env);
      const ownSegmentMatch = path.match(/^\/v1\/me\/segments\/([0-9a-f-]+)$/i);
      if (request.method === 'PATCH' && ownSegmentMatch) return updateOwnSegment(request, env, ownSegmentMatch[1]);
      if (request.method === 'DELETE' && ownSegmentMatch) return withdrawOwnSegment(request, env, ownSegmentMatch[1]);
      const voteMatch = path.match(/^\/v1\/segments\/([0-9a-f-]+)\/votes$/i);
      if (request.method === 'POST' && voteMatch) return vote(request, env, voteMatch[1]);
      const skipMatch = path.match(/^\/v1\/segments\/([0-9a-f-]+)\/skips$/i);
      if (request.method === 'POST' && skipMatch) return recordSegmentSkip(request, env, skipMatch[1]);
      const reportMatch = path.match(/^\/v1\/segments\/([0-9a-f-]+)\/reports$/i);
      if (request.method === 'POST' && reportMatch) return report(request, env, reportMatch[1]);
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      console.error('request_failed', error);
      return json({ error: 'internal_error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

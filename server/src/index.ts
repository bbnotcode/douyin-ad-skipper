import { REPORT_REASONS, VIDEO_ID_PATTERN, parseSegmentInput, statusFromVotes } from './validation';

interface Env {
  DB: D1Database;
  CLIENT_HASH_SALT?: string;
}

type SegmentRow = {
  id: string; video_id: string; start_ms: number; end_ms: number; category: string;
  status: string; upvotes: number; downvotes: number; created_at: string;
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Client-ID',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...CORS, 'Cache-Control': 'no-store', ...extra } });
}

async function bodyJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) return null;
  try { return await request.json(); } catch { return null; }
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function identityHash(request: Request, env: Env, requireClient = true): Promise<string | null> {
  if (!env.CLIENT_HASH_SALT) return null;
  const clientId = request.headers.get('X-Client-ID') || '';
  if (requireClient && !/^[0-9a-f-]{16,64}$/i.test(clientId)) return '';
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  return sha256(`${env.CLIENT_HASH_SALT}:${clientId}:${ip}`);
}

async function withinRateLimit(env: Env, identity: string, action: string, limit: number): Promise<boolean> {
  const bucket = new Date().toISOString().slice(0, 13);
  const row = await env.DB.prepare(`
    INSERT INTO rate_limits (identity_hash, action, bucket, count) VALUES (?, ?, ?, 1)
    ON CONFLICT(identity_hash, action, bucket) DO UPDATE SET count = count + 1
    RETURNING count
  `).bind(identity, action, bucket).first<{ count: number }>();
  return Boolean(row && row.count <= limit);
}

function segmentJson(row: SegmentRow) {
  return {
    id: row.id, videoId: row.video_id, start: row.start_ms / 1000, end: row.end_ms / 1000,
    category: row.category, status: row.status, upvotes: row.upvotes, downvotes: row.downvotes,
    score: row.upvotes + row.downvotes ? row.upvotes / (row.upvotes + row.downvotes) : 0,
    createdAt: row.created_at,
  };
}

async function getSegments(videoId: string, env: Env): Promise<Response> {
  if (!VIDEO_ID_PATTERN.test(videoId)) return json({ error: 'invalid_video_id' }, 400);
  const result = await env.DB.prepare(`
    SELECT id, video_id, start_ms, end_ms, category, status, upvotes, downvotes, created_at
    FROM segments WHERE video_id = ? AND status IN ('candidate', 'trusted') ORDER BY start_ms ASC LIMIT 200
  `).bind(videoId).all<SegmentRow>();
  return json({ videoId, segments: result.results.map(segmentJson) }, 200, { 'Cache-Control': 'public, max-age=60' });
}

async function submitSegment(request: Request, env: Env): Promise<Response> {
  const identity = await identityHash(request, env);
  if (identity === null) return json({ error: 'writes_not_configured' }, 503);
  if (!identity) return json({ error: 'invalid_client_id' }, 400);
  if (!await withinRateLimit(env, identity, 'submit', 10)) return json({ error: 'rate_limited' }, 429);
  const input = parseSegmentInput(await bodyJson(request));
  if (!input) return json({ error: 'invalid_segment' }, 400);
  const startMs = Math.round(input.start * 1000), endMs = Math.round(input.end * 1000);
  const existing = await env.DB.prepare(`
    SELECT id, video_id, start_ms, end_ms, category, status, upvotes, downvotes, created_at FROM segments
    WHERE video_id = ? AND category = ? AND ABS(start_ms - ?) <= 1500 AND ABS(end_ms - ?) <= 1500
    AND status != 'rejected' LIMIT 1
  `).bind(input.videoId, input.category, startMs, endMs).first<SegmentRow>();
  if (existing) return json({ segment: segmentJson(existing), duplicate: true });
  const id = crypto.randomUUID(), now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO segments (id, video_id, start_ms, end_ms, duration_ms, category, status, submitter_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)
  `).bind(id, input.videoId, startMs, endMs, input.duration == null ? null : Math.round(input.duration * 1000), input.category, identity, now, now).run();
  return json({ segment: { id, videoId: input.videoId, start: input.start, end: input.end, category: input.category, status: 'candidate', upvotes: 0, downvotes: 0, score: 0, createdAt: now } }, 201);
}

async function vote(request: Request, env: Env, segmentId: string): Promise<Response> {
  const identity = await identityHash(request, env);
  if (identity === null) return json({ error: 'writes_not_configured' }, 503);
  if (!identity) return json({ error: 'invalid_client_id' }, 400);
  if (!await withinRateLimit(env, identity, 'vote', 60)) return json({ error: 'rate_limited' }, 429);
  const body = await bodyJson(request) as { vote?: unknown } | null;
  const value = Number(body?.vote);
  if (value !== 1 && value !== -1) return json({ error: 'invalid_vote' }, 400);
  const exists = await env.DB.prepare('SELECT id FROM segments WHERE id = ?').bind(segmentId).first();
  if (!exists) return json({ error: 'segment_not_found' }, 404);
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
  const identity = await identityHash(request, env);
  if (identity === null) return json({ error: 'writes_not_configured' }, 503);
  if (!identity) return json({ error: 'invalid_client_id' }, 400);
  if (!await withinRateLimit(env, identity, 'report', 10)) return json({ error: 'rate_limited' }, 429);
  const body = await bodyJson(request) as { reason?: unknown } | null;
  const reason = String(body?.reason || '');
  if (!REPORT_REASONS.has(reason)) return json({ error: 'invalid_reason' }, 400);
  const exists = await env.DB.prepare('SELECT id FROM segments WHERE id = ?').bind(segmentId).first();
  if (!exists) return json({ error: 'segment_not_found' }, 404);
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
      if (request.method === 'GET' && path === '/health') return json({ ok: true, service: 'douyin-ad-skipper-api', version: 1 });
      const videoMatch = path.match(/^\/v1\/videos\/(\d+)\/segments$/);
      if (request.method === 'GET' && videoMatch) return getSegments(videoMatch[1], env);
      if (request.method === 'POST' && path === '/v1/segments') return submitSegment(request, env);
      const voteMatch = path.match(/^\/v1\/segments\/([0-9a-f-]+)\/votes$/i);
      if (request.method === 'POST' && voteMatch) return vote(request, env, voteMatch[1]);
      const reportMatch = path.match(/^\/v1\/segments\/([0-9a-f-]+)\/reports$/i);
      if (request.method === 'POST' && reportMatch) return report(request, env, reportMatch[1]);
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      console.error('request_failed', error);
      return json({ error: 'internal_error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

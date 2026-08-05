export const VIDEO_ID_PATTERN = /^\d{10,24}$/;
export const REPORT_REASONS = new Set(['wrong_video', 'wrong_time', 'not_ad', 'abuse', 'other']);

export type SegmentInput = {
  videoId: string;
  start: number;
  end: number;
  duration?: number;
  category: 'sponsor';
  clientRequestId: string;
};

export function parseSegmentInput(value: unknown): SegmentInput | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  const videoId = String(body.videoId || '');
  const start = Number(body.start);
  const end = Number(body.end);
  const duration = body.duration == null ? undefined : Number(body.duration);
  const category = body.category == null ? 'sponsor' : body.category;
  const clientRequestId = String(body.clientRequestId || '');
  if (!VIDEO_ID_PATTERN.test(videoId) || category !== 'sponsor') return null;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 600) return null;
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0 || end > duration + 1)) return null;
  if (!/^[0-9a-f-]{16,64}$/i.test(clientRequestId)) return null;
  return { videoId, start, end, duration, category: 'sponsor', clientRequestId };
}

export function statusFromVotes(upvotes: number, downvotes: number): 'trusted' | 'disputed' {
  const total = upvotes + downvotes;
  if (downvotes >= 2 && total > 0 && downvotes / total > 0.5) return 'disputed';
  return 'trusted';
}

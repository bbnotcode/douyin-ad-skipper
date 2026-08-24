export const VIDEO_ID_PATTERN = /^\d{10,24}$/;
export const REPORT_REASONS = new Set(['wrong_video', 'wrong_time', 'not_ad', 'abuse', 'other']);
export const SEGMENT_CATEGORIES = new Set(['sponsor', 'selfpromo', 'interaction']);

export type SegmentInput = {
  videoId: string;
  start: number;
  end: number;
  duration?: number;
  category: 'sponsor' | 'selfpromo' | 'interaction';
  clientRequestId: string;
};

export type SegmentRevisionInput = Omit<SegmentInput, 'videoId' | 'clientRequestId'>;

export type ClusterableSegment = {
  id: string;
  start_ms: number;
  end_ms: number;
  category: string;
  status: string;
  upvotes: number;
  downvotes: number;
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
  if (!VIDEO_ID_PATTERN.test(videoId) || typeof category !== 'string' || !SEGMENT_CATEGORIES.has(category)) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 600) return null;
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0 || end > duration + 1)) return null;
  if (!/^[0-9a-f-]{16,64}$/i.test(clientRequestId)) return null;
  return { videoId, start, end, duration, category: category as SegmentInput['category'], clientRequestId };
}

export function parseSegmentRevisionInput(value: unknown): SegmentRevisionInput | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  const start = Number(body.start);
  const end = Number(body.end);
  const duration = body.duration == null ? undefined : Number(body.duration);
  const category = body.category;
  if (typeof category !== 'string' || !SEGMENT_CATEGORIES.has(category)) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 600) return null;
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0 || end > duration + 1)) return null;
  return { start, end, duration, category: category as SegmentRevisionInput['category'] };
}

export function segmentsAreSimilar(a: ClusterableSegment, b: ClusterableSegment): boolean {
  if (a.category !== b.category) return false;
  const endpointMatch = Math.abs(a.start_ms - b.start_ms) <= 3000 && Math.abs(a.end_ms - b.end_ms) <= 3000;
  const overlap = Math.max(0, Math.min(a.end_ms, b.end_ms) - Math.max(a.start_ms, b.start_ms));
  const shorter = Math.max(1, Math.min(a.end_ms - a.start_ms, b.end_ms - b.start_ms));
  return endpointMatch || overlap / shorter >= 0.8;
}

export function clusterSegments<T extends ClusterableSegment>(rows: T[]): Array<T & { clusterSize: number; clusterIds: string[] }> {
  const clusters: T[][] = [];
  for (const row of [...rows].sort((a, b) => a.start_ms - b.start_ms)) {
    const cluster = clusters.find((items) => items.some((item) => segmentsAreSimilar(item, row)));
    if (cluster) cluster.push(row);
    else clusters.push([row]);
  }
  return clusters.map((items) => {
    const representative = [...items].sort((a, b) => {
      const trusted = Number(b.status === 'trusted') - Number(a.status === 'trusted');
      if (trusted) return trusted;
      const score = (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes);
      return score || a.start_ms - b.start_ms;
    })[0];
    return { ...representative, clusterSize: items.length, clusterIds: items.map((item) => item.id) };
  });
}

export function statusFromVotes(upvotes: number, downvotes: number): 'trusted' | 'disputed' {
  const total = upvotes + downvotes;
  if (downvotes >= 2 && total > 0 && downvotes / total > 0.5) return 'disputed';
  return 'trusted';
}

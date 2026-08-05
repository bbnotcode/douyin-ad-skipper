import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSegmentInput, statusFromVotes } from '../src/validation.ts';

test('accepts a valid sponsor segment', () => {
  const parsed = parseSegmentInput({ videoId:'7669344658548047311', start:10.2, end:25.4, duration:60, category:'sponsor', clientRequestId:'123e4567-e89b-12d3-a456-426614174000' });
  assert.equal(parsed?.start, 10.2);
});

test('rejects invalid ranges and oversized segments', () => {
  assert.equal(parseSegmentInput({ videoId:'7669344658548047311', start:30, end:20, clientRequestId:'123e4567-e89b-12d3-a456-426614174000' }), null);
  assert.equal(parseSegmentInput({ videoId:'7669344658548047311', start:0, end:601, clientRequestId:'123e4567-e89b-12d3-a456-426614174000' }), null);
});

test('promotes and disputes using conservative thresholds', () => {
  assert.equal(statusFromVotes(1,0), 'candidate');
  assert.equal(statusFromVotes(2,0), 'trusted');
  assert.equal(statusFromVotes(3,1), 'trusted');
  assert.equal(statusFromVotes(1,2), 'disputed');
});

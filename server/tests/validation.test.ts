import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSegmentInput, statusFromVotes } from '../src/validation.ts';
import { segmentJson } from '../src/index.ts';

test('accepts a valid sponsor segment', () => {
  const parsed = parseSegmentInput({ videoId:'7669344658548047311', start:10.2, end:25.4, duration:60, category:'sponsor', clientRequestId:'123e4567-e89b-12d3-a456-426614174000' });
  assert.equal(parsed?.start, 10.2);
});

test('accepts supported categories and rejects unknown categories', () => {
  const base={videoId:'7669344658548047311',start:10,end:20,clientRequestId:'123e4567-e89b-12d3-a456-426614174000'};
  assert.equal(parseSegmentInput({...base,category:'selfpromo'})?.category,'selfpromo');
  assert.equal(parseSegmentInput({...base,category:'interaction'})?.category,'interaction');
  assert.equal(parseSegmentInput({...base,category:'unknown'}),null);
});

test('rejects invalid ranges and oversized segments', () => {
  assert.equal(parseSegmentInput({ videoId:'7669344658548047311', start:30, end:20, clientRequestId:'123e4567-e89b-12d3-a456-426614174000' }), null);
  assert.equal(parseSegmentInput({ videoId:'7669344658548047311', start:0, end:601, clientRequestId:'123e4567-e89b-12d3-a456-426614174000' }), null);
});

test('requires a valid idempotency key', () => {
  const base={videoId:'7669344658548047311',start:10,end:20,category:'sponsor'};
  assert.equal(parseSegmentInput(base), null);
  assert.equal(parseSegmentInput({...base,clientRequestId:'too-short'}), null);
});

test('exposes ownership without leaking the submitter hash', () => {
  const segment=segmentJson({id:'segment-id',video_id:'7669344658548047311',start_ms:1000,end_ms:2000,category:'sponsor',status:'trusted',upvotes:0,downvotes:0,created_at:'2026-08-15T00:00:00Z'},true);
  assert.ok('ownedByMe' in segment);
  assert.equal(segment.ownedByMe,true);
  assert.equal('submitter_hash' in segment,false);
});

test('trusts submissions immediately and disputes bad segments', () => {
  assert.equal(statusFromVotes(0,0), 'trusted');
  assert.equal(statusFromVotes(1,0), 'trusted');
  assert.equal(statusFromVotes(2,0), 'trusted');
  assert.equal(statusFromVotes(3,1), 'trusted');
  assert.equal(statusFromVotes(1,2), 'disputed');
});

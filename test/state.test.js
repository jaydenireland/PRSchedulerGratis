import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  STATUS, STICKY_MARKER, decodeState, encodeState, findStickyComment, isDue, isExpired,
} from '../src/state.js';

const scheduled = { scheduledFor: '2026-08-26T11:05:00.000Z', requestedBy: 'octocat', status: STATUS.SCHEDULED };

describe('state encoding', () => {
  it('survives a round trip through a comment body', () => {
    const body = `### ⏰ Merge scheduled\n${encodeState(scheduled)}\nsome prose`;
    assert.deepEqual(decodeState(body), { v: 1, ...scheduled });
  });

  it('hides the payload inside an HTML comment', () => {
    assert.match(encodeState(scheduled), /^<!--[\s\S]*-->$/);
  });

  it('returns null for a body with no payload', () => {
    assert.equal(decodeState('just a normal comment'), null);
    assert.equal(decodeState(''), null);
    assert.equal(decodeState(undefined), null);
  });

  it('returns null rather than throwing on a mangled payload', () => {
    assert.equal(decodeState('<!-- pr-scheduler:state {not json} -->'), null);
    assert.equal(decodeState('<!-- pr-scheduler:state "a string" -->'), null);
  });

  it('ignores a payload written by a future version', () => {
    assert.equal(decodeState('<!-- pr-scheduler:state {"v":99,"scheduledFor":"2026-01-01T00:00:00Z"} -->'), null);
  });

  it('ignores a payload whose time is not a date', () => {
    assert.equal(decodeState('<!-- pr-scheduler:state {"v":1,"scheduledFor":"whenever"} -->'), null);
  });
});

describe('findStickyComment', () => {
  it('finds the most recent comment carrying the marker', () => {
    const comments = [
      { id: 1, body: 'first' },
      { id: 2, body: `${STICKY_MARKER} old` },
      { id: 3, body: 'chatter' },
      { id: 4, body: `${STICKY_MARKER} new` },
    ];
    assert.equal(findStickyComment(comments).id, 4);
  });

  it('returns null when there is none', () => {
    assert.equal(findStickyComment([{ id: 1, body: 'hi' }]), null);
    assert.equal(findStickyComment([]), null);
  });
});

describe('timing', () => {
  it('is due once the scheduled moment has passed', () => {
    assert.equal(isDue(scheduled, new Date('2026-08-26T11:04:59Z')), false);
    assert.equal(isDue(scheduled, new Date('2026-08-26T11:05:00Z')), true);
    assert.equal(isDue(scheduled, new Date('2026-08-26T11:06:00Z')), true);
  });

  it('is never due unless the schedule is live', () => {
    assert.equal(isDue({ ...scheduled, status: STATUS.CANCELLED }, new Date('2027-01-01T00:00:00Z')), false);
    assert.equal(isDue(null, new Date()), false);
  });

  it('expires once the grace period runs out', () => {
    assert.equal(isExpired(scheduled, 120, new Date('2026-08-26T13:00:00Z')), false);
    assert.equal(isExpired(scheduled, 120, new Date('2026-08-26T13:06:00Z')), true);
    assert.equal(isExpired(scheduled, 0, new Date('2026-08-26T11:05:01Z')), true);
  });
});

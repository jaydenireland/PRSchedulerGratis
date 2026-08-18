import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { handleClosed } from '../src/handlers/closed.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { STATUS, STICKY_MARKER, decodeState, encodeState, findStickyComment } from '../src/state.js';
import { REPO, createFakeGitHub, makePull } from './helpers/fake-github.js';

const NOW = new Date('2026-08-20T12:00:00Z');
const PR = 7;

const state = {
  status: STATUS.SCHEDULED,
  scheduledFor: '2026-08-26T11:05:00.000Z',
  requestedBy: 'octocat',
  mergeMethod: 'merge',
};

function setup({ pull = {}, scheduled = state } = {}) {
  const fake = createFakeGitHub({
    pulls: { [PR]: makePull(PR, pull) },
    labels: new Set([DEFAULT_CONFIG.label]),
    comments: { [PR]: scheduled ? [{ id: 100, body: `${STICKY_MARKER}\n${encodeState(scheduled)}` }] : [] },
  });
  const payload = { pull_request: { ...makePull(PR, pull), state: 'closed' } };
  return {
    ...fake,
    run: () => handleClosed({ octokit: fake.octokit, repo: REPO, payload, config: DEFAULT_CONFIG, now: NOW }),
    payload,
  };
}

const sticky = (harness) => findStickyComment(harness.commentsOf(PR));

describe('handleClosed', () => {
  it('drops the schedule when a pull request is closed unmerged', async () => {
    const harness = setup();
    const result = await harness.run();

    assert.equal(result.action, 'cancelled');
    assert.equal(decodeState(sticky(harness).body).status, STATUS.FAILED);
    assert.match(sticky(harness).body, /closed, so the scheduled merge was dropped/);
    assert.ok(!harness.labelsOf(PR).has(DEFAULT_CONFIG.label));
  });

  it('records a manual merge instead of reporting a failure', async () => {
    const harness = setup();
    harness.payload.pull_request.merged = true;
    harness.payload.pull_request.merged_at = '2026-08-20T11:59:00Z';
    harness.payload.pull_request.merge_commit_sha = 'abc123';

    const result = await harness.run();
    assert.equal(result.action, 'merged-elsewhere');
    assert.equal(decodeState(sticky(harness).body).status, STATUS.MERGED);
    assert.match(sticky(harness).body, /Merged on schedule/);
    assert.ok(!harness.labelsOf(PR).has(DEFAULT_CONFIG.label));
  });

  it('leaves a pull request with no schedule untouched', async () => {
    const harness = setup({ scheduled: null });
    assert.equal((await harness.run()).reason, 'nothing-scheduled');
    assert.equal(harness.commentsOf(PR).length, 0);
    assert.ok(harness.labelsOf(PR).has(DEFAULT_CONFIG.label), 'a label it did not apply is not its to remove');
  });

  it('leaves an already-cancelled schedule alone', async () => {
    const harness = setup({ scheduled: { ...state, status: STATUS.CANCELLED } });
    assert.equal((await harness.run()).reason, 'nothing-scheduled');
  });
});

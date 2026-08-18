import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { handleSweep } from '../src/handlers/sweep.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { STATUS, STICKY_MARKER, decodeState, encodeState, findStickyComment } from '../src/state.js';
import { REPO, createFakeGitHub, makePull } from './helpers/fake-github.js';

const NOW = new Date('2026-08-26T11:30:00Z');
const DUE = '2026-08-26T11:05:00.000Z';
const LATER = '2026-08-26T18:00:00.000Z';
const PR = 7;

function scheduledState(overrides = {}) {
  return {
    status: STATUS.SCHEDULED,
    scheduledFor: DUE,
    timeZoneLabel: 'UTC',
    requestedBy: 'octocat',
    mergeMethod: 'merge',
    deleteBranch: false,
    force: false,
    ...overrides,
  };
}

function stickyComment(state, id = 100) {
  return {
    id,
    body: `${STICKY_MARKER}\n${encodeState(state)}\n### ⏰ Merge scheduled`,
    user: { login: 'github-actions[bot]' },
  };
}

function setup({
  state = scheduledState(),
  pull = {},
  permissions = { octocat: 'write' },
  checkRuns = [],
  statuses = [],
  reviews = [],
  config = {},
  labelled = true,
  comments,
} = {}) {
  const fake = createFakeGitHub({
    pulls: { [PR]: makePull(PR, pull) },
    labels: new Set(labelled ? [DEFAULT_CONFIG.label] : []),
    permissions,
    checkRuns,
    statuses,
    reviews,
    comments: comments ?? { [PR]: state ? [stickyComment(state)] : [] },
  });
  return {
    ...fake,
    run: () => handleSweep({ octokit: fake.octokit, repo: REPO, config: { ...DEFAULT_CONFIG, ...config }, now: NOW }),
  };
}

const sticky = (harness) => findStickyComment(harness.commentsOf(PR));
const first = (results) => results[0] ?? { action: 'none' };

describe('handleSweep — merging', () => {
  it('merges a pull request whose time has come', async () => {
    const harness = setup();
    const result = first(await harness.run());

    assert.equal(result.action, 'merged');
    assert.deepEqual(harness.store.merges, [{ number: PR, method: 'merge' }]);
    assert.equal(decodeState(sticky(harness).body).status, STATUS.MERGED);
    assert.match(sticky(harness).body, /Merged on schedule/);
    assert.ok(!harness.labelsOf(PR).has(DEFAULT_CONFIG.label));
  });

  it('uses the merge method recorded on the schedule', async () => {
    const harness = setup({ state: scheduledState({ mergeMethod: 'squash' }) });
    await harness.run();
    assert.equal(harness.store.merges[0].method, 'squash');
  });

  it('merges once checks are green', async () => {
    const harness = setup({ checkRuns: [{ name: 'build', status: 'completed', conclusion: 'success' }] });
    assert.equal(first(await harness.run()).action, 'merged');
  });

  it('deletes the head branch when asked to', async () => {
    const harness = setup({ state: scheduledState({ deleteBranch: true }) });
    await harness.run();
    assert.deepEqual(harness.store.deletedRefs, [`heads/feature-${PR}`]);
    assert.match(sticky(harness).body, /Branch:\*\* deleted/);
  });

  it('leaves a fork\'s branch alone', async () => {
    const harness = setup({
      state: scheduledState({ deleteBranch: true }),
      pull: { head: { sha: `sha-${PR}`, ref: 'patch-1', repo: { full_name: 'someone-else/site' } } },
    });
    await harness.run();
    assert.deepEqual(harness.store.deletedRefs, []);
  });

  it('merges failing checks anyway when the schedule was forced', async () => {
    const harness = setup({
      state: scheduledState({ force: true }),
      checkRuns: [{ name: 'test', status: 'completed', conclusion: 'failure' }],
    });
    assert.equal(first(await harness.run()).action, 'merged');
  });
});

describe('handleSweep — waiting', () => {
  it('leaves a pull request alone until its time arrives', async () => {
    const harness = setup({ state: scheduledState({ scheduledFor: LATER }) });
    const result = first(await harness.run());

    assert.equal(result.action, 'waiting');
    assert.deepEqual(harness.store.merges, []);
    assert.ok(harness.labelsOf(PR).has(DEFAULT_CONFIG.label));
    assert.match(sticky(harness).body, /Merge scheduled/);
  });

  it('holds while checks are still running, and says what it is waiting for', async () => {
    const harness = setup({ checkRuns: [{ name: 'e2e', status: 'in_progress' }] });
    const result = first(await harness.run());

    assert.equal(result.action, 'holding');
    assert.deepEqual(harness.store.merges, []);
    assert.match(sticky(harness).body, /Waiting to merge/);
    assert.match(sticky(harness).body, /checks still running: `e2e`/);
    assert.ok(harness.labelsOf(PR).has(DEFAULT_CONFIG.label), 'stays in the queue');
  });

  it('holds while a check is failing, in case a rerun fixes it', async () => {
    const harness = setup({ checkRuns: [{ name: 'test', status: 'completed', conclusion: 'failure' }] });
    assert.equal(first(await harness.run()).action, 'holding');
  });

  it('holds while the pull request is still a draft', async () => {
    const harness = setup({ pull: { draft: true } });
    const result = first(await harness.run());
    assert.equal(result.action, 'holding');
    assert.match(result.reason, /draft/);
  });

  it('holds while GitHub is still computing mergeability', async () => {
    const harness = setup({ pull: { mergeable: null } });
    assert.equal(first(await harness.run()).action, 'holding');
  });

  it('holds when an approval is required and none has been given', async () => {
    const harness = setup({ config: { requireApproval: true } });
    const result = first(await harness.run());
    assert.equal(result.action, 'holding');
    assert.match(result.reason, /no approving review/);
  });

  it('merges once the required approval arrives', async () => {
    const harness = setup({ config: { requireApproval: true }, reviews: [{ user: { login: 'ana' }, state: 'APPROVED' }] });
    assert.equal(first(await harness.run()).action, 'merged');
  });

  it('writes the waiting comment once, not on every sweep', async () => {
    const harness = setup({ checkRuns: [{ name: 'e2e', status: 'in_progress' }] });
    await harness.run();
    const writes = sticky(harness).updates;

    const second = first(await harness.run());
    assert.equal(second.quiet, true);
    assert.equal(sticky(harness).updates, writes, 'the comment is left alone while nothing changes');
  });

  it('speaks up again when the reason for waiting changes', async () => {
    const harness = setup({ checkRuns: [{ name: 'e2e', status: 'in_progress' }] });
    await harness.run();
    const writes = sticky(harness).updates;

    harness.store.checkRuns = [{ name: 'e2e', status: 'completed', conclusion: 'failure' }];
    const second = first(await harness.run());
    assert.notEqual(second.quiet, true);
    assert.equal(sticky(harness).updates, writes + 1);
    assert.match(sticky(harness).body, /failing checks: `e2e`/);
  });
});

describe('handleSweep — giving up', () => {
  it('gives up straight away on merge conflicts', async () => {
    const harness = setup({ pull: { mergeable: false } });
    const result = first(await harness.run());

    assert.equal(result.action, 'failed');
    assert.match(sticky(harness).body, /Scheduled merge failed/);
    assert.match(sticky(harness).body, /conflicts/);
    assert.ok(!harness.labelsOf(PR).has(DEFAULT_CONFIG.label), 'leaves the queue');
  });

  it('gives up once the grace period has run out', async () => {
    const harness = setup({
      state: scheduledState({ scheduledFor: '2026-08-26T09:00:00.000Z' }),
      checkRuns: [{ name: 'e2e', status: 'in_progress' }],
      config: { gracePeriodMinutes: 60 },
    });
    const result = first(await harness.run());

    assert.equal(result.action, 'failed');
    assert.equal(result.reason, 'grace-period-expired');
    assert.match(sticky(harness).body, /gave up after waiting 60 minutes/);
    assert.match(sticky(harness).body, /checks still running: `e2e`/);
    assert.ok(!harness.labelsOf(PR).has(DEFAULT_CONFIG.label));
  });

  it('refuses to merge when the scheduler has lost write access', async () => {
    const harness = setup({ permissions: { octocat: 'read' } });
    const result = first(await harness.run());

    assert.equal(result.action, 'failed');
    assert.equal(result.reason, 'permission-revoked');
    assert.deepEqual(harness.store.merges, []);
    assert.match(sticky(harness).body, /no longer has `write` permission/);
  });

  it('reports a pull request closed between the queue scan and the merge', async () => {
    const harness = setup();
    const original = harness.octokit.rest.pulls.get;
    harness.octokit.rest.pulls.get = async (params) => {
      harness.store.pulls[PR].state = 'closed';
      return original(params);
    };

    const result = first(await harness.run());
    assert.equal(result.action, 'failed');
    assert.equal(result.reason, 'closed');
    assert.match(sticky(harness).body, /closed before its scheduled merge time/);
    assert.ok(!harness.labelsOf(PR).has(DEFAULT_CONFIG.label));
  });

  it('holds when GitHub itself refuses the merge', async () => {
    const harness = setup({ pull: { mergeBlocked: true } });
    const result = first(await harness.run());
    assert.equal(result.action, 'holding');
    assert.match(result.reason, /GitHub refused the merge/);
  });

  it('does not merge a head commit that moved since the check', async () => {
    const harness = setup();
    // Simulate a push landing between reading the pull request and merging it.
    const original = harness.octokit.rest.pulls.get;
    harness.octokit.rest.pulls.get = async (params) => {
      const response = await original(params);
      harness.store.pulls[PR].head.sha = 'sha-moved';
      return response;
    };
    const result = first(await harness.run());
    assert.equal(result.action, 'holding');
    assert.deepEqual(harness.store.merges, []);
  });
});

describe('handleSweep — housekeeping', () => {
  it('takes the label off a pull request that has no schedule', async () => {
    const harness = setup({ state: null });
    const result = first(await harness.run());

    assert.equal(result.action, 'unlabelled');
    assert.ok(!harness.labelsOf(PR).has(DEFAULT_CONFIG.label));
  });

  it('takes the label off a schedule that was already cancelled', async () => {
    const harness = setup({ state: scheduledState({ status: STATUS.CANCELLED }) });
    assert.equal(first(await harness.run()).action, 'unlabelled');
    assert.ok(!harness.labelsOf(PR).has(DEFAULT_CONFIG.label));
  });

  it('notices a pull request that was merged by hand', async () => {
    const harness = setup({ pull: { merged: true, merge_commit_sha: 'abc123' } });
    const result = first(await harness.run());

    assert.equal(result.action, 'already-merged');
    assert.deepEqual(harness.store.merges, []);
    assert.ok(!harness.labelsOf(PR).has(DEFAULT_CONFIG.label));
  });

  it('does nothing when no pull request carries the label', async () => {
    const harness = setup({ labelled: false });
    assert.deepEqual(await harness.run(), []);
  });

  it('carries on with the queue when one pull request breaks', async () => {
    const fake = createFakeGitHub({
      pulls: { 7: makePull(7), 8: makePull(8) },
      labels: new Set([DEFAULT_CONFIG.label]),
      permissions: { octocat: 'write' },
      comments: { 7: [stickyComment(scheduledState(), 100)], 8: [stickyComment(scheduledState(), 200)] },
    });
    const broken = fake.octokit.rest.pulls.get;
    fake.octokit.rest.pulls.get = async (params) => {
      if (params.pull_number === 7) throw new Error('boom');
      return broken(params);
    };

    const results = await handleSweep({ octokit: fake.octokit, repo: REPO, config: DEFAULT_CONFIG, now: NOW });
    assert.equal(results.find((r) => r.number === 7).action, 'errored');
    assert.equal(results.find((r) => r.number === 8).action, 'merged');
  });
});

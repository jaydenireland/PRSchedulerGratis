import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { handleComment } from '../src/handlers/comment.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { STATUS, STICKY_MARKER, decodeState, encodeState, findStickyComment } from '../src/state.js';
import { REPO, createFakeGitHub, makeComment, makePull } from './helpers/fake-github.js';

const NOW = new Date('2026-08-18T12:00:00Z');
const PR = 7;

function setup({ body, author = 'octocat', permissions = { octocat: 'write' }, comments = {}, config = {} } = {}) {
  const fake = createFakeGitHub({
    pulls: { [PR]: makePull(PR) },
    permissions,
    comments,
  });
  const payload = {
    issue: { number: PR, pull_request: { url: `#${PR}` } },
    comment: makeComment(body, { user: { login: author, type: 'User' } }),
  };
  return {
    ...fake,
    payload,
    run: () => handleComment({
      octokit: fake.octokit, repo: REPO, payload, config: { ...DEFAULT_CONFIG, ...config }, now: NOW,
    }),
  };
}

const sticky = (harness) => findStickyComment(harness.commentsOf(PR));

describe('handleComment — scheduling', () => {
  it('records a schedule, labels the pull request and gives a thumbs up', async () => {
    const harness = setup({ body: '@prscheduler 26/08/2026T11:05' });
    const result = await harness.run();

    assert.equal(result.action, 'scheduled');
    const state = decodeState(sticky(harness).body);
    assert.equal(state.scheduledFor, '2026-08-26T11:05:00.000Z');
    assert.equal(state.status, STATUS.SCHEDULED);
    assert.equal(state.requestedBy, 'octocat');
    assert.ok(harness.labelsOf(PR).has(DEFAULT_CONFIG.label));
    assert.deepEqual(harness.store.reactions, [{ id: 1, content: '+1' }]);
  });

  it('creates the tracking label if the repository has not got one', async () => {
    const harness = setup({ body: '@prscheduler 26/08/2026T11:05' });
    assert.ok(!harness.store.repoLabels.has(DEFAULT_CONFIG.label));
    await harness.run();
    assert.ok(harness.store.repoLabels.has(DEFAULT_CONFIG.label));
  });

  it('shows the requested time in the comment as well as UTC', async () => {
    const harness = setup({ body: '@prscheduler 26/08/2026T12:05 BST' });
    await harness.run();
    const body = sticky(harness).body;
    assert.match(body, /11:05 UTC/);
    assert.match(body, /Requested as:.*12:05 BST/);
  });

  it('honours merge-method and branch options from the comment', async () => {
    const harness = setup({ body: '@prscheduler in 2 hours --squash --delete-branch' });
    await harness.run();
    const state = decodeState(sticky(harness).body);
    assert.equal(state.mergeMethod, 'squash');
    assert.equal(state.deleteBranch, true);
    assert.equal(state.scheduledFor, '2026-08-18T14:00:00.000Z');
  });

  it('falls back to the configured merge method', async () => {
    const harness = setup({ body: '@prscheduler in 2 hours', config: { mergeMethod: 'rebase' } });
    await harness.run();
    assert.equal(decodeState(sticky(harness).body).mergeMethod, 'rebase');
  });

  it('rewrites the one status comment instead of adding another', async () => {
    const harness = setup({ body: '@prscheduler 26/08/2026T11:05' });
    await harness.run();
    const first = sticky(harness).id;

    harness.payload.comment = makeComment('@prscheduler 27/08/2026T09:00', { id: 2 });
    const result = await harness.run();

    assert.equal(result.action, 'rescheduled');
    assert.equal(harness.commentsOf(PR).filter((c) => c.body.includes(STICKY_MARKER)).length, 1);
    assert.equal(sticky(harness).id, first);
    assert.equal(decodeState(sticky(harness).body).scheduledFor, '2026-08-27T09:00:00.000Z');
    assert.match(sticky(harness).body, /Merge rescheduled/);
  });
});

describe('handleComment — cancelling and querying', () => {
  it('cancels a schedule and drops the label', async () => {
    const harness = setup({ body: '@prscheduler 26/08/2026T11:05' });
    await harness.run();

    harness.payload.comment = makeComment('@prscheduler cancel', { id: 2 });
    const result = await harness.run();

    assert.equal(result.action, 'cancelled');
    assert.equal(decodeState(sticky(harness).body).status, STATUS.CANCELLED);
    assert.ok(!harness.labelsOf(PR).has(DEFAULT_CONFIG.label));
  });

  it('says so when there is nothing to cancel', async () => {
    const harness = setup({ body: '@prscheduler cancel' });
    const result = await harness.run();
    assert.equal(result.action, 'nothing-to-cancel');
    assert.match(harness.commentsOf(PR).at(-1).body, /Nothing scheduled/);
  });

  it('reports the current schedule on request', async () => {
    const harness = setup({ body: '@prscheduler 26/08/2026T11:05' });
    await harness.run();

    harness.payload.comment = makeComment('@prscheduler status', { id: 2 });
    await harness.run();
    assert.match(harness.commentsOf(PR).at(-1).body, /Scheduled/);
  });

  it('answers help without needing any permission', async () => {
    const harness = setup({ body: '@prscheduler help', author: 'stranger', permissions: {} });
    const result = await harness.run();
    assert.equal(result.action, 'help');
    assert.match(harness.commentsOf(PR).at(-1).body, /PR Scheduler/);
  });
});

describe('handleComment — refusals', () => {
  it('refuses someone without write permission', async () => {
    const harness = setup({ body: '@prscheduler 26/08/2026T11:05', author: 'stranger', permissions: { stranger: 'read' } });
    const result = await harness.run();

    assert.equal(result.action, 'denied');
    assert.equal(sticky(harness), null);
    assert.ok(!harness.labelsOf(PR).has(DEFAULT_CONFIG.label));
    assert.match(harness.commentsOf(PR).at(-1).body, /needs `write` permission/);
  });

  it('refuses someone who is not a collaborator at all', async () => {
    const harness = setup({ body: '@prscheduler 26/08/2026T11:05', author: 'drive-by', permissions: {} });
    assert.equal((await harness.run()).action, 'denied');
  });

  it('honours a stricter minimum-permission setting', async () => {
    const harness = setup({
      body: '@prscheduler 26/08/2026T11:05',
      permissions: { octocat: 'write' },
      config: { minimumPermission: 'admin' },
    });
    assert.equal((await harness.run()).action, 'denied');
  });

  it('rejects a time in the past', async () => {
    const harness = setup({ body: '@prscheduler 26/08/2019T11:05' });
    const result = await harness.run();
    assert.equal(result.action, 'error');
    assert.match(harness.commentsOf(PR).at(-1).body, /in the past/);
    assert.ok(!harness.labelsOf(PR).has(DEFAULT_CONFIG.label));
  });

  it('rejects a time further out than max-schedule-days', async () => {
    const harness = setup({ body: '@prscheduler 26/08/2030T11:05' });
    const result = await harness.run();
    assert.equal(result.action, 'error');
    assert.match(harness.commentsOf(PR).at(-1).body, /more than 365 days away/);
  });

  it('explains a time it cannot read', async () => {
    const harness = setup({ body: '@prscheduler sometime soon' });
    assert.equal((await harness.run()).action, 'error');
    assert.match(harness.commentsOf(PR).at(-1).body, /couldn't schedule that/);
    assert.deepEqual(harness.store.reactions, [{ id: 1, content: 'confused' }]);
  });
});

describe('handleComment — comments it should leave alone', () => {
  it('ignores a comment on an issue rather than a pull request', async () => {
    const harness = setup({ body: '@prscheduler 26/08/2026T11:05' });
    harness.payload.issue = { number: PR };
    assert.equal((await harness.run()).reason, 'not-a-pull-request');
    assert.equal(harness.commentsOf(PR).length, 0);
  });

  it('ignores a comment with no command in it', async () => {
    const harness = setup({ body: 'Looks good, ship it' });
    assert.equal((await harness.run()).reason, 'no-command');
    assert.equal(harness.commentsOf(PR).length, 0);
  });

  it('never answers its own status comment', async () => {
    const harness = setup({ body: `${STICKY_MARKER}\n${encodeState({ status: STATUS.SCHEDULED })}\n@prscheduler help` });
    assert.equal((await harness.run()).reason, 'self');
  });

  it('ignores a command quoted from an earlier comment', async () => {
    const harness = setup({ body: '> @prscheduler 26/08/2026T11:05\n\nWhy would you do that?' });
    assert.equal((await harness.run()).reason, 'no-command');
  });
});

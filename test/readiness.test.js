import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { evaluateReadiness, summarizeChecks, summarizeReviews } from '../src/readiness.js';

const config = { requireChecks: true, requireApproval: false };
const openPull = { state: 'open', merged: false, draft: false, mergeable: true };
const passing = { state: 'success', pending: [], failing: [] };

describe('summarizeChecks', () => {
  it('is happy when everything has passed', () => {
    const summary = summarizeChecks({ checkRuns: [{ name: 'build', status: 'completed', conclusion: 'success' }] });
    assert.equal(summary.state, 'success');
  });

  it('counts neutral and skipped runs as passing', () => {
    const summary = summarizeChecks({
      checkRuns: [
        { name: 'a', status: 'completed', conclusion: 'neutral' },
        { name: 'b', status: 'completed', conclusion: 'skipped' },
      ],
    });
    assert.equal(summary.state, 'success');
  });

  it('is pending while a run is unfinished', () => {
    const summary = summarizeChecks({ checkRuns: [{ name: 'test', status: 'in_progress' }] });
    assert.equal(summary.state, 'pending');
    assert.deepEqual(summary.pending, ['test']);
  });

  it('is failing when a run failed, even if others are pending', () => {
    const summary = summarizeChecks({
      checkRuns: [
        { name: 'test', status: 'completed', conclusion: 'failure' },
        { name: 'build', status: 'in_progress' },
      ],
    });
    assert.equal(summary.state, 'failure');
    assert.deepEqual(summary.failing, ['test']);
  });

  it('treats timed out, cancelled and action_required as failures', () => {
    for (const conclusion of ['timed_out', 'cancelled', 'action_required', 'startup_failure']) {
      assert.equal(summarizeChecks({ checkRuns: [{ name: 'x', status: 'completed', conclusion }] }).state, 'failure', conclusion);
    }
  });

  it('ignores runs superseded by a newer attempt', () => {
    const summary = summarizeChecks({ checkRuns: [{ name: 'old', status: 'completed', conclusion: 'stale' }] });
    assert.equal(summary.state, 'success');
    assert.equal(summary.total, 0);
  });

  it('folds in legacy commit statuses', () => {
    const summary = summarizeChecks({ statuses: [{ context: 'ci/legacy', state: 'failure' }] });
    assert.equal(summary.state, 'failure');
    assert.deepEqual(summary.failing, ['ci/legacy']);
  });

  it('counts only the newest status per context', () => {
    const summary = summarizeChecks({
      statuses: [
        { context: 'ci/legacy', state: 'success' },
        { context: 'ci/legacy', state: 'failure' },
      ],
    });
    assert.equal(summary.state, 'success');
    assert.equal(summary.total, 1);
  });

  it('is happy when there are no checks at all', () => {
    assert.equal(summarizeChecks({}).state, 'success');
  });
});

describe('summarizeReviews', () => {
  it('keeps only each reviewer\'s latest verdict', () => {
    const summary = summarizeReviews([
      { user: { login: 'ana' }, state: 'CHANGES_REQUESTED' },
      { user: { login: 'ana' }, state: 'APPROVED' },
    ]);
    assert.equal(summary.approved, 1);
    assert.equal(summary.changesRequested, 0);
  });

  it('does not let a plain comment overwrite a verdict', () => {
    const summary = summarizeReviews([
      { user: { login: 'ana' }, state: 'APPROVED' },
      { user: { login: 'ana' }, state: 'COMMENTED' },
    ]);
    assert.equal(summary.approved, 1);
  });

  it('counts requested changes from a different reviewer', () => {
    const summary = summarizeReviews([
      { user: { login: 'ana' }, state: 'APPROVED' },
      { user: { login: 'bo' }, state: 'CHANGES_REQUESTED' },
    ]);
    assert.equal(summary.approved, 1);
    assert.equal(summary.changesRequested, 1);
  });
});

describe('evaluateReadiness', () => {
  it('is ready when the pull request is open, mergeable and green', () => {
    assert.deepEqual(evaluateReadiness({ pull: openPull, checks: passing, config }), { ready: true });
  });

  it('gives up permanently on a merged or closed pull request', () => {
    assert.equal(evaluateReadiness({ pull: { ...openPull, merged: true }, config }).fatal, true);
    assert.equal(evaluateReadiness({ pull: { ...openPull, state: 'closed' }, config }).fatal, true);
  });

  it('gives up permanently on conflicts', () => {
    const verdict = evaluateReadiness({ pull: { ...openPull, mergeable: false }, config });
    assert.equal(verdict.fatal, true);
    assert.match(verdict.reason, /conflicts/);
  });

  it('waits, without giving up, while mergeability is unknown', () => {
    const verdict = evaluateReadiness({ pull: { ...openPull, mergeable: null }, config });
    assert.equal(verdict.ready, false);
    assert.notEqual(verdict.fatal, true);
  });

  it('waits while the pull request is a draft', () => {
    const verdict = evaluateReadiness({ pull: { ...openPull, draft: true }, config });
    assert.equal(verdict.ready, false);
    assert.notEqual(verdict.fatal, true);
    assert.match(verdict.reason, /draft/);
  });

  it('waits on failing or running checks, naming them', () => {
    const failing = evaluateReadiness({ pull: openPull, checks: { state: 'failure', failing: ['test'], pending: [] }, config });
    assert.match(failing.reason, /failing checks: `test`/);
    const pending = evaluateReadiness({ pull: openPull, checks: { state: 'pending', failing: [], pending: ['build'] }, config });
    assert.match(pending.reason, /checks still running: `build`/);
  });

  it('truncates a long list of failing checks', () => {
    const verdict = evaluateReadiness({
      pull: openPull,
      checks: { state: 'failure', failing: ['a', 'b', 'c', 'd', 'e'], pending: [] },
      config,
    });
    assert.match(verdict.reason, /`a`, `b`, `c` and 2 more/);
  });

  it('ignores checks entirely when they are not required', () => {
    const verdict = evaluateReadiness({
      pull: openPull,
      checks: { state: 'failure', failing: ['test'], pending: [] },
      config: { ...config, requireChecks: false },
    });
    assert.deepEqual(verdict, { ready: true });
  });

  it('lets --force override failing checks and missing approvals', () => {
    const verdict = evaluateReadiness({
      pull: openPull,
      checks: { state: 'failure', failing: ['test'], pending: [] },
      config: { requireChecks: true, requireApproval: true },
      force: true,
    });
    assert.deepEqual(verdict, { ready: true });
  });

  it('does not let --force override conflicts', () => {
    assert.equal(evaluateReadiness({ pull: { ...openPull, mergeable: false }, config, force: true }).fatal, true);
  });

  it('waits for an approval when one is required', () => {
    const strict = { requireChecks: false, requireApproval: true };
    assert.match(evaluateReadiness({ pull: openPull, reviews: [], config: strict }).reason, /no approving review/);
    assert.match(
      evaluateReadiness({ pull: openPull, reviews: [{ user: { login: 'bo' }, state: 'CHANGES_REQUESTED' }], config: strict }).reason,
      /requested changes/,
    );
    assert.deepEqual(
      evaluateReadiness({ pull: openPull, reviews: [{ user: { login: 'ana' }, state: 'APPROVED' }], config: strict }),
      { ready: true },
    );
  });
});

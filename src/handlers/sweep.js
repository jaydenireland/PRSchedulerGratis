/**
 * Handles the cron run: find pull requests whose moment has come and merge them.
 *
 * Every scheduled pull request carries the tracking label, so one cheap issue
 * search finds the whole queue no matter how large the repository is.
 */

import * as core from '@actions/core';
import { STATUS, decodeState, findStickyComment, isDue, isExpired } from '../state.js';
import { evaluateReadiness, summarizeChecks } from '../readiness.js';
import { renderFailed, renderMerged, renderWaiting } from '../render.js';
import {
  deleteBranch, fetchChecks, getPullRequest, hasPermission, listComments, listReviews,
  listScheduledPulls, mergePullRequest, removeLabel, upsertSticky,
} from '../github.js';

/** Merge failures that mean "not right now" rather than "never". */
const RETRYABLE_MERGE_STATUS = new Set([405, 409, 422]);

export async function handleSweep({ octokit, repo, config, now = new Date() }) {
  const numbers = await listScheduledPulls(octokit, repo, config.label);
  core.info(`${numbers.length} pull request(s) carry the \`${config.label}\` label.`);

  const results = [];
  for (const number of numbers) {
    try {
      const result = await processScheduled({ octokit, repo, config, now, number });
      core.info(`#${number}: ${result.action}${result.reason ? ` (${result.reason})` : ''}`);
      results.push({ number, ...result });
    } catch (error) {
      // One broken pull request must not strand the rest of the queue.
      core.warning(`#${number} could not be processed: ${error.message}`);
      results.push({ number, action: 'errored', reason: error.message });
    }
  }

  const merged = results.filter((result) => result.action === 'merged').map((result) => result.number);
  core.setOutput('merged', JSON.stringify(merged));
  core.setOutput('processed', String(results.length));
  if (merged.length > 0) core.info(`Merged: ${merged.map((n) => `#${n}`).join(', ')}`);
  return results;
}

async function processScheduled({ octokit, repo, config, now, number }) {
  const comments = await listComments(octokit, repo, number);
  const sticky = findStickyComment(comments);
  const state = sticky ? decodeState(sticky.body) : null;

  if (!state || state.status !== STATUS.SCHEDULED) {
    // The label outlived its schedule — most likely someone applied it by hand.
    await removeLabel(octokit, repo, number, config.label);
    return { action: 'unlabelled', reason: state ? `state is ${state.status}` : 'no schedule found' };
  }

  if (!isDue(state, now)) return { action: 'waiting', reason: `due ${state.scheduledFor}` };

  const pull = await getPullRequest(octokit, repo, number);

  if (pull.merged) {
    await finish(octokit, repo, number, config, comments,
      renderMerged({ state: { ...state, status: STATUS.MERGED, mergedAt: pull.merged_at }, config, sha: pull.merge_commit_sha }));
    return { action: 'already-merged' };
  }
  if (pull.state !== 'open') {
    await finish(octokit, repo, number, config, comments,
      renderFailed({ state: { ...state, status: STATUS.FAILED }, config, reason: 'This pull request was closed before its scheduled merge time.' }));
    return { action: 'failed', reason: 'closed' };
  }

  // Permission is re-checked at merge time: access granted a week ago may have
  // been revoked since the schedule was created.
  const permission = await hasPermission(octokit, repo, state.requestedBy, config.minimumPermission);
  if (!permission.allowed) {
    await finish(octokit, repo, number, config, comments,
      renderFailed({
        state: { ...state, status: STATUS.FAILED },
        config,
        reason: `@${state.requestedBy} no longer has \`${config.minimumPermission}\` permission on this repository, so I did not merge.`,
      }));
    return { action: 'failed', reason: 'permission-revoked' };
  }

  const needsChecks = config.requireChecks && !state.force;
  const needsReviews = config.requireApproval && !state.force;
  const [checkData, reviews] = await Promise.all([
    needsChecks ? fetchChecks(octokit, repo, pull.head.sha) : Promise.resolve(null),
    needsReviews ? listReviews(octokit, repo, number) : Promise.resolve([]),
  ]);

  const readiness = evaluateReadiness({
    pull,
    checks: checkData ? summarizeChecks(checkData) : null,
    reviews,
    config,
    force: state.force,
  });

  if (!readiness.ready) {
    return holdOrFail({ octokit, repo, config, now, number, state, comments, readiness });
  }

  try {
    const result = await mergePullRequest(octokit, repo, pull, state.mergeMethod);
    const merged = { ...state, status: STATUS.MERGED, mergedAt: now.toISOString() };
    let branchDeleted = false;
    if (state.deleteBranch) branchDeleted = await deleteBranch(octokit, repo, pull);
    await finish(octokit, repo, number, config, comments,
      renderMerged({ state: merged, config, sha: result.sha, branchDeleted }));
    return { action: 'merged', sha: result.sha };
  } catch (error) {
    const retryable = RETRYABLE_MERGE_STATUS.has(error.status);
    const reason = error.response?.data?.message ?? error.message;
    if (!retryable) throw error;
    return holdOrFail({
      octokit, repo, config, now, number, state, comments,
      readiness: { ready: false, reason: `GitHub refused the merge — ${reason}` },
    });
  }
}

/**
 * A due pull request that isn't ready: keep trying until the grace period runs
 * out, then give up and say why.
 */
async function holdOrFail({ octokit, repo, config, now, number, state, comments, readiness }) {
  if (readiness.fatal) {
    await finish(octokit, repo, number, config, comments,
      renderFailed({ state: { ...state, status: STATUS.FAILED }, config, reason: readiness.reason }));
    return { action: 'failed', reason: readiness.reason };
  }

  if (isExpired(state, config.gracePeriodMinutes, now)) {
    await finish(octokit, repo, number, config, comments,
      renderFailed({
        state: { ...state, status: STATUS.FAILED },
        config,
        reason: `I gave up after waiting ${config.gracePeriodMinutes} minutes past the scheduled time.`,
        detail: `Still blocked by: ${readiness.reason}.`,
      }));
    return { action: 'failed', reason: 'grace-period-expired' };
  }

  // The sweep runs every few minutes; rewriting the same text each time would
  // churn the comment for no one's benefit. Only speak up when the block changes.
  if (state.lastBlockedBy === readiness.reason) {
    return { action: 'holding', reason: readiness.reason, quiet: true };
  }
  const held = { ...state, lastBlockedBy: readiness.reason };
  await upsertSticky(octokit, repo, number, renderWaiting({ state: held, config, reason: readiness.reason }), comments);
  return { action: 'holding', reason: readiness.reason };
}

/** Write the final status comment and take the pull request out of the queue. */
async function finish(octokit, repo, number, config, comments, body) {
  await upsertSticky(octokit, repo, number, body, comments);
  await removeLabel(octokit, repo, number, config.label);
}

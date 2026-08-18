/**
 * Handles `pull_request` closed events: tidy up a schedule that can no longer
 * happen, rather than leaving a stale label until the cron notices.
 */

import * as core from '@actions/core';
import { STATUS, decodeState, findStickyComment } from '../state.js';
import { renderFailed, renderMerged } from '../render.js';
import { listComments, removeLabel, upsertSticky } from '../github.js';

export async function handleClosed({ octokit, repo, payload, config, now = new Date() }) {
  const pull = payload.pull_request;
  if (!pull) return { action: 'skipped', reason: 'no-pull-request' };

  const number = pull.number;
  const comments = await listComments(octokit, repo, number);
  const sticky = findStickyComment(comments);
  const state = sticky ? decodeState(sticky.body) : null;

  if (!state || state.status !== STATUS.SCHEDULED) {
    return { action: 'skipped', reason: 'nothing-scheduled' };
  }

  const body = pull.merged
    ? renderMerged({
      state: { ...state, status: STATUS.MERGED, mergedAt: pull.merged_at ?? now.toISOString() },
      config,
      sha: pull.merge_commit_sha,
    })
    : renderFailed({
      state: { ...state, status: STATUS.FAILED },
      config,
      reason: 'This pull request was closed, so the scheduled merge was dropped.',
    });

  await upsertSticky(octokit, repo, number, body, comments);
  await removeLabel(octokit, repo, number, config.label);
  core.info(`#${number} closed — schedule cleared.`);
  return { action: pull.merged ? 'merged-elsewhere' : 'cancelled' };
}

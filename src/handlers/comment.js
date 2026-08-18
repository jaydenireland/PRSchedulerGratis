/**
 * Handles `issue_comment` events: someone typed a command on a pull request.
 */

import * as core from '@actions/core';
import { parseCommand } from '../command.js';
import { STATUS, decodeState, findStickyComment } from '../state.js';
import { STICKY_MARKER } from '../github.js';
import {
  renderCancelled, renderDenied, renderError, renderHelp, renderScheduled, renderStatus,
} from '../render.js';
import {
  addLabel, addReaction, ensureLabel, hasPermission, listComments, removeLabel, reply, upsertSticky,
} from '../github.js';

const PAST_TOLERANCE_MS = 60_000;

export async function handleComment({ octokit, repo, payload, config, now = new Date() }) {
  const issue = payload.issue;
  const comment = payload.comment;

  if (!issue?.pull_request) {
    core.info('Comment is on an issue rather than a pull request — nothing to do.');
    return { action: 'skipped', reason: 'not-a-pull-request' };
  }
  // Our own status comment mentions the trigger; don't answer ourselves.
  if (String(comment?.body ?? '').includes(STICKY_MARKER)) {
    core.info('Comment is my own status comment — ignoring.');
    return { action: 'skipped', reason: 'self' };
  }

  const command = parseCommand(comment.body, {
    trigger: config.trigger,
    defaultTimeZone: config.timezone,
    now,
  });

  if (!command) {
    core.info(`No \`${config.trigger}\` command in this comment.`);
    return { action: 'skipped', reason: 'no-command' };
  }
  core.info(`Parsed command: ${command.kind}`);

  const actor = comment.user?.login ?? 'unknown';
  const number = issue.number;

  // Help is free; everything else needs write access, because everything else
  // can change what lands on the default branch.
  if (command.kind === 'help') {
    await reply(octokit, repo, number, renderHelp({ config }));
    return { action: 'help' };
  }

  const permission = await hasPermission(octokit, repo, actor, config.minimumPermission);
  if (!permission.allowed) {
    core.warning(`@${actor} has \`${permission.level}\` permission; \`${config.minimumPermission}\` is required.`);
    if (config.reactions) await addReaction(octokit, repo, comment.id, 'eyes');
    await reply(octokit, repo, number, renderDenied({ actor, config }));
    return { action: 'denied', level: permission.level };
  }

  if (command.kind === 'error') {
    if (config.reactions) await addReaction(octokit, repo, comment.id, 'confused');
    await reply(octokit, repo, number, renderError({ message: command.message, config }));
    return { action: 'error' };
  }

  const comments = await listComments(octokit, repo, number);
  const sticky = findStickyComment(comments);
  const existing = sticky ? decodeState(sticky.body) : null;

  if (command.kind === 'status') {
    await reply(octokit, repo, number, renderStatus({ state: existing, config, now }));
    return { action: 'status' };
  }

  if (command.kind === 'cancel') {
    if (!existing || existing.status !== STATUS.SCHEDULED) {
      await reply(octokit, repo, number, renderStatus({ state: null, config, now }));
      return { action: 'nothing-to-cancel' };
    }
    const state = { ...existing, status: STATUS.CANCELLED, cancelledBy: actor, cancelledAt: now.toISOString() };
    await upsertSticky(octokit, repo, number, renderCancelled({ state, config, actor }), comments);
    await removeLabel(octokit, repo, number, config.label);
    if (config.reactions) await addReaction(octokit, repo, comment.id, '+1');
    core.info(`Cancelled the scheduled merge for #${number}.`);
    return { action: 'cancelled' };
  }

  // command.kind === 'schedule'
  const scheduledFor = command.scheduledFor;
  const problem = validateSchedule(scheduledFor, config, now);
  if (problem) {
    if (config.reactions) await addReaction(octokit, repo, comment.id, 'confused');
    await reply(octokit, repo, number, renderError({ message: problem, config }));
    return { action: 'error', reason: 'invalid-time' };
  }

  const state = {
    status: STATUS.SCHEDULED,
    scheduledFor: scheduledFor.toISOString(),
    timeZoneLabel: command.timeZoneLabel,
    requestedBy: actor,
    requestedAt: now.toISOString(),
    commandUrl: comment.html_url,
    mergeMethod: command.options.mergeMethod ?? config.mergeMethod,
    deleteBranch: command.options.deleteBranch ?? config.deleteBranch,
    force: command.options.force ?? false,
  };

  const rescheduled = Boolean(existing && existing.status === STATUS.SCHEDULED);
  await ensureLabel(octokit, repo, config);
  await upsertSticky(octokit, repo, number, renderScheduled({ state, config, rescheduled }), comments);
  await addLabel(octokit, repo, number, config.label);
  if (config.reactions) await addReaction(octokit, repo, comment.id, '+1');

  core.info(`#${number} will merge at ${state.scheduledFor} using \`${state.mergeMethod}\`.`);
  core.setOutput('scheduled-for', state.scheduledFor);
  return { action: rescheduled ? 'rescheduled' : 'scheduled', state };
}

function validateSchedule(scheduledFor, config, now) {
  const deltaMs = scheduledFor.getTime() - now.getTime();
  if (deltaMs < -PAST_TOLERANCE_MS) {
    return `That time is in the past (${scheduledFor.toISOString()}). Pick a moment in the future.`;
  }
  const maxMs = config.maxScheduleDays * 86_400_000;
  if (deltaMs > maxMs) {
    return `That is more than ${config.maxScheduleDays} days away. Pick a nearer time, or raise \`max-schedule-days\` in \`.github/pr-scheduler.yml\`.`;
  }
  return null;
}

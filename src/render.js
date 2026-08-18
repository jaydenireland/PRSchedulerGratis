/**
 * The bot's voice: every comment it writes on a pull request.
 *
 * Scheduling comments are "sticky" — one comment per pull request, rewritten in
 * place as the state changes, so a pull request rescheduled five times still
 * shows a single up-to-date status instead of five stale ones.
 */

import { formatInZone, humanizeDelta, resolveTimeZone } from './datetime.js';
import { STICKY_MARKER, encodeState } from './state.js';

const FOOTER = '<sub>Scheduled with [PR Scheduler](https://github.com/jaydenireland/PRSchedulerGratis) · comment `{trigger} help` for usage</sub>';

const footer = (trigger) => FOOTER.replace('{trigger}', trigger);

/** Build the sticky comment body from a state object. */
function sticky(state, body, trigger) {
  return [STICKY_MARKER, encodeState(state), '', body, '', '---', footer(trigger)].join('\n');
}

/**
 * Render the scheduled time in UTC and, when it differs, the requester's zone.
 *
 * A sticky comment is written once and read days later, so it carries absolute
 * times only; "in 8 days" would be a lie by the time anyone scrolled back to it.
 * The `status` reply is generated on demand and can afford the friendlier phrasing.
 */
function whenLines(state, { now, relative = false } = {}) {
  const at = new Date(state.scheduledFor);
  const suffix = relative && now ? ` (${humanizeDelta(now, at)})` : '';
  const lines = [`**Merging at:** ${formatInZone(at, 'UTC')} UTC${suffix}`];

  const label = state.timeZoneLabel;
  if (label && label !== 'UTC' && label !== 'Z') {
    try {
      const { timeZone } = resolveTimeZone(label);
      lines.push(`**Requested as:** ${formatInZone(at, timeZone)} ${label}`);
    } catch {
      // An unresolvable label just means we show UTC only.
    }
  }
  return lines;
}

export function renderScheduled({ state, config, rescheduled = false }) {
  const heading = rescheduled ? '### ⏰ Merge rescheduled' : '### ⏰ Merge scheduled';
  const details = [
    ...whenLines(state),
    `**Merge method:** \`${state.mergeMethod}\``,
    `**Requested by:** @${state.requestedBy}`,
  ];
  if (state.deleteBranch) details.push('**Branch:** will be deleted after merging');
  if (state.force) details.push('**Checks:** skipped (`--force`)');
  else if (config.requireChecks) details.push('**Checks:** must be passing at merge time');
  if (config.requireApproval) details.push('**Review:** an approval is required at merge time');

  const body = [
    heading,
    '',
    ...details.map((line) => `- ${line}`),
    '',
    `Reschedule by commenting a new time, or cancel with \`${config.trigger} cancel\`.`,
  ].join('\n');

  return sticky(state, body, config.trigger);
}

export function renderMerged({ state, config, sha, branchDeleted }) {
  const details = [
    `**Merged at:** ${formatInZone(new Date(state.mergedAt ?? Date.now()), 'UTC')} UTC`,
    `**Merge method:** \`${state.mergeMethod}\``,
    `**Scheduled by:** @${state.requestedBy}`,
  ];
  if (sha) details.push(`**Commit:** ${sha}`);
  if (branchDeleted) details.push('**Branch:** deleted');

  return sticky(state, ['### ✅ Merged on schedule', '', ...details.map((line) => `- ${line}`)].join('\n'), config.trigger);
}

export function renderCancelled({ state, config, actor }) {
  const body = [
    '### 🚫 Scheduled merge cancelled',
    '',
    `Cancelled by @${actor}. This pull request will not be merged automatically.`,
    '',
    `Schedule it again with \`${config.trigger} DD/MM/YYYYTHH:MM\`.`,
  ].join('\n');
  return sticky(state, body, config.trigger);
}

export function renderFailed({ state, config, reason, detail }) {
  const body = [
    '### ❌ Scheduled merge failed',
    '',
    reason,
    ...(detail ? ['', detail] : []),
    '',
    `Fix the problem and schedule again with \`${config.trigger} DD/MM/YYYYTHH:MM\`.`,
  ].join('\n');
  return sticky(state, body, config.trigger);
}

export function renderWaiting({ state, config, reason }) {
  const deadline = new Date(Date.parse(state.scheduledFor) + config.gracePeriodMinutes * 60_000);
  const body = [
    '### ⏳ Waiting to merge',
    '',
    "The scheduled time has passed, but this pull request isn't ready to merge yet.",
    '',
    `- **Blocked by:** ${reason}`,
    `- **Giving up:** ${formatInZone(deadline, 'UTC')} UTC`,
    '',
    'I will keep trying until then.',
  ].join('\n');
  return sticky(state, body, config.trigger);
}

/** A one-off reply, not sticky — used for errors, help and status. */
export function renderReply(body, trigger) {
  return [body, '', '---', footer(trigger)].join('\n');
}

export function renderError({ message, config }) {
  return renderReply(
    ['### ⚠️ I couldn\'t schedule that', '', message, '', `Comment \`${config.trigger} help\` to see the accepted formats.`].join('\n'),
    config.trigger,
  );
}

export function renderDenied({ actor, config }) {
  return renderReply(
    [
      '### 🔒 Not scheduled',
      '',
      `@${actor} needs \`${config.minimumPermission}\` permission on this repository to schedule a merge.`,
    ].join('\n'),
    config.trigger,
  );
}

export function renderStatus({ state, config, now = new Date() }) {
  if (!state || state.status !== 'scheduled') {
    return renderReply(
      `### 📭 Nothing scheduled\n\nThis pull request has no scheduled merge. Add one with \`${config.trigger} DD/MM/YYYYTHH:MM\`.`,
      config.trigger,
    );
  }
  const body = [
    '### ⏰ Scheduled',
    '',
    ...whenLines(state, { now, relative: true }).map((line) => `- ${line}`),
    `- **Merge method:** \`${state.mergeMethod}\``,
  ].join('\n');
  return renderReply(body, config.trigger);
}

export function renderHelp({ config }) {
  const t = config.trigger;
  const body = [
    '### ⏰ PR Scheduler',
    '',
    'Comment one of these on a pull request:',
    '',
    '| Command | What it does |',
    '| --- | --- |',
    `| \`${t} 26/08/2026T11:05\` | Merge at that time (${config.timezone}) |`,
    `| \`${t} 26/08/2026T11:05 BST\` | Merge at that time in a named zone |`,
    `| \`${t} 26/08/2026T11:05 GMT+5\` | Merge at that time at a UTC offset |`,
    `| \`${t} 2026-08-26T11:05Z\` | ISO-8601 also works |`,
    `| \`${t} in 3 hours\` | Merge after a delay |`,
    `| \`${t} cancel\` | Cancel the scheduled merge |`,
    `| \`${t} status\` | Show the current schedule |`,
    `| \`${t} help\` | Show this table |`,
    '',
    '**Options** — add to a scheduling comment:',
    '',
    '| Option | What it does |',
    '| --- | --- |',
    '| `--squash`, `--rebase`, `--merge` | Choose the merge method |',
    '| `--delete-branch` / `--no-delete-branch` | Delete the head branch after merging |',
    '| `--force` | Merge even if checks are failing |',
    '',
    'Commenting a new time replaces the old one.',
    '',
    '<details><summary>Current settings</summary>',
    '',
    `- Default timezone: \`${config.timezone}\``,
    `- Default merge method: \`${config.mergeMethod}\``,
    `- Checks must pass: \`${config.requireChecks}\``,
    `- Approval required: \`${config.requireApproval}\``,
    `- Minimum permission to schedule: \`${config.minimumPermission}\``,
    `- Grace period after the scheduled time: \`${config.gracePeriodMinutes}\` minutes`,
    '',
    '</details>',
  ].join('\n');
  return renderReply(body, t);
}

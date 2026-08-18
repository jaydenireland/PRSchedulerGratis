/**
 * Where a schedule lives.
 *
 * There is no database behind this action, so the bot's own sticky comment is
 * the record: a JSON payload tucked into an HTML comment that GitHub renders as
 * nothing. The sweep reads it back on every run.
 */

export const STICKY_MARKER = '<!-- pr-scheduler:sticky -->';
const STATE_PATTERN = /<!--\s*pr-scheduler:state\s+([\s\S]*?)\s*-->/;
export const STATE_VERSION = 1;

export const STATUS = {
  SCHEDULED: 'scheduled',
  MERGED: 'merged',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
};

export function encodeState(state) {
  return `<!-- pr-scheduler:state ${JSON.stringify({ v: STATE_VERSION, ...state })} -->`;
}

/**
 * Read the payload back out of a comment body.
 * Returns null for anything we can't make sense of, so a hand-edited comment
 * degrades to "no schedule" rather than crashing the sweep.
 */
export function decodeState(body) {
  const match = STATE_PATTERN.exec(String(body ?? ''));
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.v !== STATE_VERSION) return null;
    if (parsed.scheduledFor && Number.isNaN(Date.parse(parsed.scheduledFor))) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The most recent sticky comment authored by this action. */
export function findStickyComment(comments) {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    if (String(comments[i].body ?? '').includes(STICKY_MARKER)) return comments[i];
  }
  return null;
}

/** True when the schedule is live and its moment has arrived. */
export function isDue(state, now = new Date()) {
  if (!state || state.status !== STATUS.SCHEDULED || !state.scheduledFor) return false;
  return Date.parse(state.scheduledFor) <= now.getTime();
}

/**
 * How long we keep retrying a due merge that isn't ready yet (checks running,
 * mergeability still being computed). Past this, the schedule is abandoned.
 */
export function isExpired(state, gracePeriodMinutes, now = new Date()) {
  if (!state?.scheduledFor) return false;
  return now.getTime() > Date.parse(state.scheduledFor) + gracePeriodMinutes * 60_000;
}

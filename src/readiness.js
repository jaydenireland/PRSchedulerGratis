/**
 * Deciding whether a due pull request can actually be merged.
 *
 * Split out from the API layer so the rules are testable without a network:
 * everything here is a pure function over data already fetched.
 */

/** Conclusions that mean a check has finished and is not happy. */
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'cancelled', 'startup_failure']);
/** Conclusions that finished without objecting. */
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * Fold check runs and legacy commit statuses into one verdict.
 *
 * @param {{checkRuns?: Array, statuses?: Array}} input
 * @returns {{state: 'success'|'pending'|'failure', pending: string[], failing: string[], total: number}}
 */
export function summarizeChecks({ checkRuns = [], statuses = [] } = {}) {
  const pending = [];
  const failing = [];
  let total = 0;

  for (const run of checkRuns) {
    // `stale` results were superseded by a newer run of the same check.
    if (run.conclusion === 'stale') continue;
    total += 1;
    if (run.status !== 'completed') pending.push(run.name);
    else if (FAILING_CONCLUSIONS.has(run.conclusion)) failing.push(run.name);
    else if (!PASSING_CONCLUSIONS.has(run.conclusion)) pending.push(run.name);
  }

  // The commit status API reports the latest status per context.
  const seen = new Set();
  for (const status of statuses) {
    if (seen.has(status.context)) continue;
    seen.add(status.context);
    total += 1;
    if (status.state === 'pending') pending.push(status.context);
    else if (status.state === 'failure' || status.state === 'error') failing.push(status.context);
  }

  let state = 'success';
  if (failing.length > 0) state = 'failure';
  else if (pending.length > 0) state = 'pending';

  return { state, pending, failing, total };
}

/**
 * Fold reviews into a verdict. Only the latest review per person counts,
 * matching how GitHub itself resolves a review thread.
 */
export function summarizeReviews(reviews = []) {
  const latest = new Map();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login) continue;
    // COMMENTED and PENDING reviews never override a person's stated position.
    if (review.state === 'COMMENTED' || review.state === 'PENDING') continue;
    latest.set(login, review.state);
  }
  const states = [...latest.values()];
  return {
    approved: states.filter((state) => state === 'APPROVED').length,
    changesRequested: states.filter((state) => state === 'CHANGES_REQUESTED').length,
    reviewers: latest,
  };
}

const list = (names, limit = 3) => {
  const shown = names.slice(0, limit).map((name) => `\`${name}\``).join(', ');
  return names.length > limit ? `${shown} and ${names.length - limit} more` : shown;
};

/**
 * Can this pull request be merged right now?
 *
 * @returns {{ready: boolean, fatal?: boolean, reason?: string}}
 *   `fatal` marks a problem that waiting will not fix, so the schedule is
 *   abandoned immediately rather than retried until the grace period expires.
 */
export function evaluateReadiness({ pull, checks, reviews = [], config, force = false }) {
  if (pull.merged) return { ready: false, fatal: true, reason: 'This pull request has already been merged.' };
  if (pull.state !== 'open') return { ready: false, fatal: true, reason: 'This pull request is closed.' };
  if (pull.draft) return { ready: false, reason: 'the pull request is still a draft' };

  if (pull.mergeable === false) {
    return { ready: false, fatal: true, reason: 'This pull request has conflicts that must be resolved before it can merge.' };
  }
  if (pull.mergeable === null || pull.mergeable === undefined) {
    // GitHub computes mergeability asynchronously; it will be ready shortly.
    return { ready: false, reason: 'GitHub is still working out whether the branches merge cleanly' };
  }

  if (config.requireChecks && !force) {
    const summary = checks ?? { state: 'success', pending: [], failing: [] };
    if (summary.state === 'failure') {
      return { ready: false, reason: `failing checks: ${list(summary.failing)}` };
    }
    if (summary.state === 'pending') {
      return { ready: false, reason: `checks still running: ${list(summary.pending)}` };
    }
  }

  if (config.requireApproval && !force) {
    const summary = summarizeReviews(reviews);
    if (summary.changesRequested > 0) return { ready: false, reason: 'a reviewer has requested changes' };
    if (summary.approved === 0) return { ready: false, reason: 'the pull request has no approving review' };
  }

  return { ready: true };
}

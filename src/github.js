/**
 * Everything that talks to the GitHub API.
 *
 * Kept apart from the decision logic so the rules can be tested without a
 * network and this file stays a thin, obvious wrapper over Octokit.
 */

import { STICKY_MARKER, findStickyComment } from './state.js';

/** Ascending, so an index comparison answers "at least this much access?". */
const PERMISSION_ORDER = ['none', 'read', 'triage', 'write', 'maintain', 'admin'];

export async function getPullRequest(octokit, { owner, repo }, number) {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
  return data;
}

export async function listComments(octokit, { owner, repo }, number) {
  return octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number: number, per_page: 100,
  });
}

/**
 * Write the bot's single status comment, editing the existing one if there is
 * one so a pull request never collects a wall of scheduling comments.
 */
export async function upsertSticky(octokit, { owner, repo }, number, body, comments) {
  const existing = findStickyComment(comments ?? await listComments(octokit, { owner, repo }, number));
  if (existing) {
    // Rewriting identical text still bumps the comment's timestamp and mails
    // watchers, so leave it alone when nothing actually changed.
    if (existing.body === body) return existing;
    const { data } = await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    return data;
  }
  const { data } = await octokit.rest.issues.createComment({ owner, repo, issue_number: number, body });
  return data;
}

export async function reply(octokit, { owner, repo }, number, body) {
  const { data } = await octokit.rest.issues.createComment({ owner, repo, issue_number: number, body });
  return data;
}

export async function addReaction(octokit, { owner, repo }, commentId, content) {
  try {
    await octokit.rest.reactions.createForIssueComment({ owner, repo, comment_id: commentId, content });
  } catch {
    // Reactions are decoration; never fail a merge because one didn't stick.
  }
}

/** Create the tracking label on first use so no manual setup is needed. */
export async function ensureLabel(octokit, { owner, repo }, config) {
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name: config.label });
    return true;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  try {
    await octokit.rest.issues.createLabel({
      owner, repo, name: config.label, color: config.labelColor, description: config.labelDescription,
    });
    return true;
  } catch (error) {
    // A concurrent run may have created it first; anything else is worth knowing.
    if (error.status === 422) return true;
    throw error;
  }
}

export async function addLabel(octokit, { owner, repo }, number, label) {
  await octokit.rest.issues.addLabels({ owner, repo, issue_number: number, labels: [label] });
}

export async function removeLabel(octokit, { owner, repo }, number, label) {
  try {
    await octokit.rest.issues.removeLabel({ owner, repo, issue_number: number, name: label });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

/**
 * Does `username` hold at least `minimum` permission on the repository?
 *
 * This is the security boundary: without it, anyone who can comment on a public
 * repository could merge to the default branch.
 */
export async function hasPermission(octokit, { owner, repo }, username, minimum) {
  let level = 'none';
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
    // `role_name` distinguishes triage/maintain; the legacy field flattens them.
    level = String(data.role_name ?? data.permission ?? 'none').toLowerCase();
  } catch (error) {
    if (error.status === 404 || error.status === 403) return { allowed: false, level: 'none' };
    throw error;
  }

  const held = PERMISSION_ORDER.indexOf(level);
  const needed = PERMISSION_ORDER.indexOf(String(minimum).toLowerCase());
  // An unrecognised custom role is not something we can reason about — deny.
  if (held === -1) return { allowed: false, level };
  return { allowed: held >= (needed === -1 ? PERMISSION_ORDER.indexOf('write') : needed), level };
}

/** Check runs and legacy commit statuses for a commit. */
export async function fetchChecks(octokit, { owner, repo }, ref) {
  const [checkRuns, statuses] = await Promise.all([
    octokit.paginate(octokit.rest.checks.listForRef, { owner, repo, ref, per_page: 100, filter: 'latest' })
      .catch((error) => { if (error.status === 403 || error.status === 404) return []; throw error; }),
    octokit.paginate(octokit.rest.repos.listCommitStatusesForRef, { owner, repo, ref, per_page: 100 })
      .catch((error) => { if (error.status === 403 || error.status === 404) return []; throw error; }),
  ]);
  return { checkRuns, statuses };
}

export async function listReviews(octokit, { owner, repo }, number) {
  return octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 });
}

/** Open pull requests carrying the tracking label. */
export async function listScheduledPulls(octokit, { owner, repo }, label) {
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner, repo, state: 'open', labels: label, per_page: 100,
  });
  return issues.filter((issue) => issue.pull_request).map((issue) => issue.number);
}

export async function mergePullRequest(octokit, { owner, repo }, pull, mergeMethod) {
  const { data } = await octokit.rest.pulls.merge({
    owner,
    repo,
    pull_number: pull.number,
    merge_method: mergeMethod,
    sha: pull.head.sha, // Refuse to merge work that landed after the schedule was checked.
  });
  return data;
}

export async function deleteBranch(octokit, { owner, repo }, pull) {
  // Never touch a fork's branch: it isn't ours to delete.
  const head = String(pull.head.repo?.full_name ?? '').toLowerCase();
  if (head !== `${owner}/${repo}`.toLowerCase()) return false;
  try {
    await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${pull.head.ref}` });
    return true;
  } catch (error) {
    if (error.status === 404 || error.status === 422) return false;
    throw error;
  }
}

export { STICKY_MARKER };

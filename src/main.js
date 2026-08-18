/**
 * PR Scheduler — merge pull requests at a time you choose, by commenting.
 *
 * One action, three jobs, picked from the event that started it:
 *   issue_comment          → read the command and record a schedule
 *   schedule / dispatch    → merge everything whose time has come
 *   pull_request (closed)  → clear a schedule that can no longer run
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import { applyInputOverrides, loadConfig } from './config.js';
import { handleComment } from './handlers/comment.js';
import { handleSweep } from './handlers/sweep.js';
import { handleClosed } from './handlers/closed.js';

/** REST calls that change something, and so are stubbed out by `dry-run`. */
const WRITE_METHODS = new Set([
  'issues.createComment', 'issues.updateComment', 'issues.addLabels',
  'issues.removeLabel', 'issues.createLabel', 'reactions.createForIssueComment',
  'pulls.merge', 'git.deleteRef',
]);

function withDryRun(octokit) {
  const rest = new Proxy(octokit.rest, {
    get(namespaces, namespaceName) {
      const namespace = namespaces[namespaceName];
      if (typeof namespace !== 'object' || namespace === null) return namespace;
      return new Proxy(namespace, {
        get(methods, methodName) {
          const key = `${String(namespaceName)}.${String(methodName)}`;
          if (!WRITE_METHODS.has(key)) return methods[methodName];
          return async (params = {}) => {
            const summary = params.body ? `\n${String(params.body).split('\n').slice(0, 4).join('\n')}…` : '';
            core.info(`[dry run] ${key}(${params.issue_number ?? params.pull_number ?? params.comment_id ?? ''})${summary}`);
            return { data: { id: 0, sha: 'dry-run', body: params.body } };
          };
        },
      });
    },
  });
  // Prototype delegation keeps `paginate`, `request` and the plugins intact.
  const stubbed = Object.create(octokit);
  stubbed.rest = rest;
  return stubbed;
}

function resolveMode(requested, eventName, payload) {
  if (requested && requested !== 'auto') return requested;
  if (eventName === 'issue_comment') return 'comment';
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    return payload.action === 'closed' ? 'closed' : 'none';
  }
  return 'sweep';
}

export async function run() {
  const token = core.getInput('token') || process.env.GITHUB_TOKEN;
  if (!token) {
    core.setFailed('No token supplied. Pass `token: ${{ secrets.GITHUB_TOKEN }}` to the action.');
    return;
  }

  // Tolerate an unset input: `getBooleanInput` throws on an empty string.
  const dryRun = (core.getInput('dry-run') || 'false').trim().toLowerCase() === 'true';
  const octokit = dryRun ? withDryRun(github.getOctokit(token)) : github.getOctokit(token);
  const repo = github.context.repo;
  const { eventName, payload } = github.context;

  // Read settings from the base branch, never the pull request head: a pull
  // request must not be able to loosen the rules that govern merging it.
  const { config: fileConfig, warnings, path } = await loadConfig(octokit, repo);
  if (path) core.info(`Using settings from \`${path}\`.`);
  for (const warning of warnings) core.warning(`${path ?? 'config'}: ${warning}`);

  const { config, warnings: inputWarnings } = applyInputOverrides(fileConfig, {
    trigger: core.getInput('trigger'),
    timezone: core.getInput('timezone'),
    mergeMethod: core.getInput('merge-method'),
    deleteBranch: core.getInput('delete-branch'),
    requireChecks: core.getInput('require-checks'),
    requireApproval: core.getInput('require-approval'),
    minimumPermission: core.getInput('minimum-permission'),
    label: core.getInput('label'),
    gracePeriodMinutes: core.getInput('grace-period-minutes'),
    maxScheduleDays: core.getInput('max-schedule-days'),
  });
  for (const warning of inputWarnings) core.warning(`inputs: ${warning}`);

  const mode = resolveMode(core.getInput('mode'), eventName, payload);
  if (dryRun) core.info('Dry run: no comments, labels or merges will be written.');
  core.info(`Event \`${eventName}\` → mode \`${mode}\`.`);

  const now = new Date();
  let result;
  switch (mode) {
    case 'comment':
      result = await handleComment({ octokit, repo, payload, config, now });
      break;
    case 'sweep':
      result = await handleSweep({ octokit, repo, config, now });
      break;
    case 'closed':
      result = await handleClosed({ octokit, repo, payload, config, now });
      break;
    default:
      core.info(`Nothing to do for \`${eventName}\`.`);
      result = { action: 'skipped' };
  }

  core.setOutput('action', Array.isArray(result) ? 'sweep' : result.action);
}

// `import.meta.main` is not available in the bundled output, so run on load.
run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
  if (error?.stack) core.debug(error.stack);
});

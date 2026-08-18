/**
 * End-to-end check of the bundled action.
 *
 * Unit tests exercise the modules directly; this one runs `dist/index.js` as a
 * real GitHub Actions process — event payload on disk, inputs in the
 * environment, API calls over HTTP — so a broken build cannot pass CI.
 */

import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DIST = new URL('../dist/index.js', import.meta.url).pathname;
const hasBundle = existsSync(DIST);

/** Records every request so a test can assert on what the action did. */
function mockGitHub(routes) {
  const calls = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      const path = request.url.split('?')[0];
      const key = `${request.method} ${path}`;
      calls.push({ key, body });

      const route = routes[key];
      const [status, payload] = typeof route === 'function' ? route(body) : route ?? [404, { message: 'Not Found' }];
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload ?? {}));
    });
  });
  return { server, calls };
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

describe('bundled action', { skip: hasBundle ? false : 'run `npm run build` first' }, () => {
  let workspace;

  before(async () => { workspace = await mkdtemp(join(tmpdir(), 'pr-scheduler-')); });

  async function runAction({ routes, event, eventName, inputs = {} }) {
    const { server, calls } = mockGitHub(routes);
    const port = await listen(server);
    const eventPath = join(workspace, 'event.json');
    const outputPath = join(workspace, 'output.txt');
    await writeFile(eventPath, JSON.stringify(event));
    await writeFile(outputPath, '');

    try {
      const { stdout } = await run(process.execPath, [DIST], {
        env: {
          PATH: process.env.PATH,
          GITHUB_API_URL: `http://127.0.0.1:${port}`,
          GITHUB_REPOSITORY: 'acme/site',
          GITHUB_EVENT_NAME: eventName,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
          INPUT_TOKEN: 'test-token',
          // The bundle must reach the mock server directly, not via a proxy.
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
          ...inputs,
        },
      });
      return { stdout, calls, outputs: await readFile(outputPath, 'utf8') };
    } finally {
      server.close();
    }
  }

  // Octokit percent-encodes the `path` parameter, so the slash arrives as %2F.
  const CONFIG_ROUTE = 'GET /repos/acme/site/contents/.github%2Fpr-scheduler.yml';
  const noConfig = { [CONFIG_ROUTE]: [404, { message: 'Not Found' }] };

  const commentEvent = (body) => ({
    action: 'created',
    issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/acme/site/pulls/7' } },
    comment: { id: 55, body, user: { login: 'octocat', type: 'User' }, html_url: 'https://github.com/acme/site/pull/7#issuecomment-55' },
  });

  it('schedules a merge from a real issue_comment payload', async () => {
    const { stdout, calls, outputs } = await runAction({
      eventName: 'issue_comment',
      event: commentEvent('@prscheduler 26/08/2030T11:05 BST --squash'),
      routes: {
        ...noConfig,
        'GET /repos/acme/site/collaborators/octocat/permission': [200, { role_name: 'write', permission: 'write' }],
        'GET /repos/acme/site/issues/7/comments': [200, []],
        'GET /repos/acme/site/labels/scheduled-merge': [404, { message: 'Not Found' }],
        'POST /repos/acme/site/labels': [201, { name: 'scheduled-merge' }],
        'POST /repos/acme/site/issues/7/comments': [201, { id: 900 }],
        'POST /repos/acme/site/issues/7/labels': [200, []],
        'POST /repos/acme/site/issues/comments/55/reactions': [201, {}],
      },
      inputs: { 'INPUT_MAX-SCHEDULE-DAYS': '3000' },
    });

    assert.match(stdout, /mode `comment`/);
    const posted = calls.find((call) => call.key === 'POST /repos/acme/site/issues/7/comments');
    assert.ok(posted, 'it posts a status comment');
    assert.match(posted.body.body, /Merge scheduled/);
    assert.match(posted.body.body, /2030-08-26T10:05:00\.000Z/);
    assert.match(posted.body.body, /`squash`/);

    assert.ok(calls.some((call) => call.key === 'POST /repos/acme/site/issues/7/labels'), 'it labels the pull request');
    assert.ok(calls.some((call) => call.key === 'POST /repos/acme/site/issues/comments/55/reactions'), 'it reacts');
    assert.match(outputs, /scheduled-for/);
  });

  it('refuses a commenter without write permission', async () => {
    const { calls } = await runAction({
      eventName: 'issue_comment',
      event: commentEvent('@prscheduler 26/08/2030T11:05'),
      routes: {
        ...noConfig,
        'GET /repos/acme/site/collaborators/octocat/permission': [200, { role_name: 'read', permission: 'read' }],
        'POST /repos/acme/site/issues/7/comments': [201, { id: 900 }],
        'POST /repos/acme/site/issues/comments/55/reactions': [201, {}],
      },
    });

    const posted = calls.find((call) => call.key === 'POST /repos/acme/site/issues/7/comments');
    assert.match(posted.body.body, /needs `write` permission/);
    assert.ok(!calls.some((call) => call.key === 'POST /repos/acme/site/issues/7/labels'), 'it does not label');
  });

  it('reads settings from .github/pr-scheduler.yml', async () => {
    const config = ['trigger: "/ship"', 'merge-method: rebase', 'timezone: Europe/London'].join('\n');
    const { stdout, calls } = await runAction({
      eventName: 'issue_comment',
      event: commentEvent('/ship 26/12/2030T11:05'),
      routes: {
        [CONFIG_ROUTE]: [200, {
          content: Buffer.from(config, 'utf8').toString('base64'), encoding: 'base64',
        }],
        'GET /repos/acme/site/collaborators/octocat/permission': [200, { role_name: 'admin', permission: 'admin' }],
        'GET /repos/acme/site/issues/7/comments': [200, []],
        'GET /repos/acme/site/labels/scheduled-merge': [200, { name: 'scheduled-merge' }],
        'POST /repos/acme/site/issues/7/comments': [201, { id: 900 }],
        'POST /repos/acme/site/issues/7/labels': [200, []],
        'POST /repos/acme/site/issues/comments/55/reactions': [201, {}],
      },
      inputs: { 'INPUT_MAX-SCHEDULE-DAYS': '3000' },
    });

    assert.match(stdout, /Using settings from `\.github\/pr-scheduler\.yml`/);
    const posted = calls.find((call) => call.key === 'POST /repos/acme/site/issues/7/comments');
    assert.match(posted.body.body, /`rebase`/, 'the configured merge method is used');
    // December in London is UTC+0, so the wall clock is unchanged.
    assert.match(posted.body.body, /2030-12-26T11:05:00\.000Z/);
  });

  it('merges a due pull request on a scheduled run', async () => {
    const state = { v: 1, status: 'scheduled', scheduledFor: '2020-01-01T00:00:00.000Z', requestedBy: 'octocat', mergeMethod: 'squash', deleteBranch: false, force: true };
    const { calls, outputs } = await runAction({
      eventName: 'schedule',
      event: {},
      routes: {
        ...noConfig,
        'GET /repos/acme/site/issues': [200, [{ number: 7, pull_request: { url: 'x' } }]],
        'GET /repos/acme/site/issues/7/comments': [200, [{
          id: 900,
          body: `<!-- pr-scheduler:sticky -->\n<!-- pr-scheduler:state ${JSON.stringify(state)} -->`,
        }]],
        'GET /repos/acme/site/pulls/7': [200, {
          number: 7, state: 'open', merged: false, draft: false, mergeable: true,
          head: { sha: 'deadbeef', ref: 'feature', repo: { full_name: 'acme/site' } },
        }],
        'GET /repos/acme/site/collaborators/octocat/permission': [200, { role_name: 'write', permission: 'write' }],
        'PUT /repos/acme/site/pulls/7/merge': [200, { sha: 'mergedsha', merged: true }],
        'PATCH /repos/acme/site/issues/comments/900': [200, { id: 900 }],
        'DELETE /repos/acme/site/issues/7/labels/scheduled-merge': [200, []],
      },
    });

    const merge = calls.find((call) => call.key === 'PUT /repos/acme/site/pulls/7/merge');
    assert.ok(merge, 'it merges the pull request');
    assert.equal(merge.body.merge_method, 'squash');
    assert.equal(merge.body.sha, 'deadbeef', 'it pins the head commit it checked');

    const update = calls.find((call) => call.key === 'PATCH /repos/acme/site/issues/comments/900');
    assert.match(update.body.body, /Merged on schedule/);
    assert.ok(calls.some((call) => call.key === 'DELETE /repos/acme/site/issues/7/labels/scheduled-merge'), 'it leaves the queue');
    assert.match(outputs, /merged/);
  });

  it('writes nothing when dry-run is on', async () => {
    const { stdout, calls } = await runAction({
      eventName: 'issue_comment',
      event: commentEvent('@prscheduler 26/08/2030T11:05'),
      routes: {
        ...noConfig,
        'GET /repos/acme/site/collaborators/octocat/permission': [200, { role_name: 'write', permission: 'write' }],
        'GET /repos/acme/site/issues/7/comments': [200, []],
        'GET /repos/acme/site/labels/scheduled-merge': [200, { name: 'scheduled-merge' }],
      },
      inputs: { 'INPUT_DRY-RUN': 'true', 'INPUT_MAX-SCHEDULE-DAYS': '3000' },
    });

    assert.match(stdout, /Dry run/);
    assert.match(stdout, /\[dry run\] issues.createComment/);
    const wrote = calls.filter((call) => call.key.startsWith('POST') || call.key.startsWith('PATCH') || call.key.startsWith('PUT'));
    assert.deepEqual(wrote, [], 'no write reached the API');
  });
});

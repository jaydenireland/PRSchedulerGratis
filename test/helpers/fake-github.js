/**
 * A small in-memory stand-in for the parts of the GitHub API this action uses.
 *
 * It stores comments, labels and merge state so handler tests can assert on
 * what the action actually did, rather than on which calls it made.
 */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.response = { data: { message } };
  }
}

export function createFakeGitHub({
  pulls = {},
  permissions = {},
  labels = new Set(),
  comments = {}, // keyed by pull request number
  checkRuns = [],
  statuses = [],
  reviews = [],
  configFile = null,
} = {}) {
  const store = {
    pulls: structuredClone(pulls),
    permissions,
    repoLabels: new Set(['bug']),
    issueLabels: new Map(),
    comments: new Map(Object.entries(structuredClone(comments)).map(([key, value]) => [Number(key), value])),
    checkRuns,
    statuses,
    reviews,
    configFile,
    nextCommentId: 1000,
    merges: [],
    deletedRefs: [],
    reactions: [],
  };
  for (const [number, pull] of Object.entries(store.pulls)) {
    store.issueLabels.set(Number(number), new Set(pull.labels ?? [...labels]));
  }

  const commentsOf = (number) => {
    if (!store.comments.has(number)) store.comments.set(number, []);
    return store.comments.get(number);
  };

  const labelsOf = (number) => {
    if (!store.issueLabels.has(number)) store.issueLabels.set(number, new Set());
    return store.issueLabels.get(number);
  };

  const rest = {
    pulls: {
      get: async ({ pull_number: number }) => {
        const pull = store.pulls[number];
        if (!pull) throw new HttpError(404, 'Not Found');
        // The API hands back a snapshot; later changes to the store must not
        // retroactively alter what a caller already read.
        return { data: structuredClone(pull) };
      },
      merge: async ({ pull_number: number, merge_method: method, sha }) => {
        const pull = store.pulls[number];
        if (!pull) throw new HttpError(404, 'Not Found');
        if (pull.mergeBlocked) throw new HttpError(405, 'Pull Request is not mergeable');
        if (sha && sha !== pull.head.sha) throw new HttpError(409, 'Head branch was modified');
        pull.merged = true;
        pull.state = 'closed';
        pull.merge_commit_sha = `merged-${number}`;
        store.merges.push({ number, method });
        return { data: { sha: `merged-${number}`, merged: true } };
      },
      listReviews: async () => ({ data: store.reviews }),
    },
    issues: {
      listComments: async ({ issue_number: number }) => ({ data: commentsOf(number) }),
      createComment: async ({ issue_number: number, body }) => {
        const comment = { id: (store.nextCommentId += 1), body, issue_number: number, user: { login: 'github-actions[bot]' } };
        commentsOf(number).push(comment);
        return { data: comment };
      },
      updateComment: async ({ comment_id: id, body }) => {
        const comment = [...store.comments.values()].flat().find((entry) => entry.id === id);
        if (!comment) throw new HttpError(404, 'Not Found');
        comment.body = body;
        comment.updates = (comment.updates ?? 0) + 1;
        return { data: comment };
      },
      addLabels: async ({ issue_number: number, labels: names }) => {
        for (const name of names) labelsOf(number).add(name);
        return { data: [...labelsOf(number)] };
      },
      removeLabel: async ({ issue_number: number, name }) => {
        if (!labelsOf(number).has(name)) throw new HttpError(404, 'Label does not exist');
        labelsOf(number).delete(name);
        return { data: [] };
      },
      getLabel: async ({ name }) => {
        if (!store.repoLabels.has(name)) throw new HttpError(404, 'Not Found');
        return { data: { name } };
      },
      createLabel: async ({ name }) => {
        store.repoLabels.add(name);
        return { data: { name } };
      },
      listForRepo: async ({ labels: label }) => {
        const matches = [];
        for (const [number, names] of store.issueLabels) {
          if (names.has(label) && store.pulls[number]?.state === 'open') {
            matches.push({ number, pull_request: { url: `#${number}` } });
          }
        }
        return { data: matches };
      },
    },
    reactions: {
      createForIssueComment: async ({ comment_id: id, content }) => {
        store.reactions.push({ id, content });
        return { data: {} };
      },
    },
    repos: {
      getCollaboratorPermissionLevel: async ({ username }) => {
        const role = store.permissions[username];
        if (!role) throw new HttpError(404, 'Not Found');
        return { data: { role_name: role, permission: role } };
      },
      getContent: async ({ path }) => {
        if (!store.configFile || store.configFile.path !== path) throw new HttpError(404, 'Not Found');
        return { data: { content: Buffer.from(store.configFile.content, 'utf8').toString('base64'), encoding: 'base64' } };
      },
      listCommitStatusesForRef: async () => ({ data: store.statuses }),
    },
    checks: {
      // The real endpoint wraps its array, and `paginate` unwraps it.
      listForRef: async () => ({ data: { total_count: store.checkRuns.length, check_runs: store.checkRuns } }),
    },
    git: {
      deleteRef: async ({ ref }) => {
        store.deletedRefs.push(ref);
        return { data: {} };
      },
    },
  };

  // Real `paginate` unwraps `{data}` and follows Link headers; one page is enough here.
  const paginate = async (method, params) => {
    const { data } = await method(params);
    return Array.isArray(data) ? data : data.check_runs ?? [];
  };

  return { octokit: { rest, paginate }, store, labelsOf, commentsOf };
}

export const REPO = { owner: 'acme', repo: 'site' };

export function makePull(number, overrides = {}) {
  return {
    number,
    state: 'open',
    merged: false,
    draft: false,
    mergeable: true,
    head: { sha: `sha-${number}`, ref: `feature-${number}`, repo: { full_name: 'acme/site' } },
    base: { ref: 'main' },
    ...overrides,
  };
}

export function makeComment(body, overrides = {}) {
  return {
    id: 1,
    body,
    user: { login: 'octocat', type: 'User' },
    html_url: 'https://github.com/acme/site/pull/7#issuecomment-1',
    ...overrides,
  };
}

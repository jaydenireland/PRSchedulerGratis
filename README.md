# PR Scheduler

Schedule a pull request to merge at a date and time you choose, by leaving a comment.

```
@prscheduler 26/08/2026T11:05 BST
```

That's it. The pull request merges itself at five past eleven, British time.

This is a free, self-hosted recreation of the [PR Scheduler](https://github.com/marketplace/pr-scheduler)
GitHub App — same comment syntax, no subscription, no third-party server. It runs as a GitHub Action
inside your own repository, so the only thing that ever sees your code is GitHub.

---

## Why you'd want this

- **Publish on a schedule.** Jekyll, Hugo, Gatsby, Astro and friends deploy on merge. Write the post
  today, merge it Tuesday at 09:00, go to bed.
- **Ship at a sensible hour.** Queue the release for Wednesday morning instead of Friday at 18:00.
- **Coordinate a launch.** Line several pull requests up on the same minute.

## Quick start

**1.** Copy [`examples/pr-scheduler.yml`](examples/pr-scheduler.yml) to `.github/workflows/pr-scheduler.yml`:

```yaml
name: PR Scheduler

on:
  issue_comment:
    types: [created, edited]
  pull_request:
    types: [closed]
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write
  issues: write
  checks: read
  statuses: read

concurrency:
  group: pr-scheduler-${{ github.event.issue.number || github.event.pull_request.number || 'sweep' }}
  cancel-in-progress: false

jobs:
  scheduler:
    if: github.event_name != 'issue_comment' || github.event.issue.pull_request
    runs-on: ubuntu-latest
    steps:
      - uses: jaydenireland/PRSchedulerGratis@v1
```

**2.** Comment on a pull request:

```
@prscheduler 26/08/2026T11:05
```

The bot replies with a confirmation, labels the pull request, and merges it when the time comes.
There is no step three — no config file, no secrets, no sign-up.

## Commands

Each command goes on its own line in a pull request comment.

| Command | What it does |
| --- | --- |
| `@prscheduler 26/08/2026T11:05` | Merge at that time, in UTC |
| `@prscheduler 26/08/2026T11:05 BST` | …in a named timezone |
| `@prscheduler 26/08/2026T11:05 GMT+5` | …at a UTC offset |
| `@prscheduler 26/08/2026T11:05 Europe/London` | …in an IANA timezone, daylight saving included |
| `@prscheduler 2026-08-26T11:05Z` | ISO-8601, if you prefer |
| `@prscheduler in 3 hours` | After a delay — also `in 30m`, `in 2 days`, `in 1 week` |
| `@prscheduler cancel` | Call it off |
| `@prscheduler status` | What's currently scheduled |
| `@prscheduler help` | The same table, in the pull request |

Comment a new time to reschedule. The bot keeps **one** status comment and rewrites it, so a pull
request rescheduled five times still reads cleanly.

### Options

Add these to a scheduling comment:

| Option | What it does |
| --- | --- |
| `--squash`, `--rebase`, `--merge` | Override the merge method for this pull request |
| `--delete-branch`, `--no-delete-branch` | Override branch deletion |
| `--force` | Merge even if checks are failing |

```
@prscheduler 26/08/2026T09:00 Europe/London --squash --delete-branch
```

### The date format

`DD/MM/YYYYTHH:MM` — **day first**, like the original app. `05/04/2026` is 5 April, not 4 May.
Times are on a 24-hour clock. Seconds are optional, `-` and `.` work as separators, and a space
works in place of the `T`.

## Configuration

Everything is optional. Drop a `.github/pr-scheduler.yml` in your repository to change the defaults:

```yaml
timezone: Europe/London     # assume UK time when a comment doesn't say
merge-method: squash        # squash by default
delete-branch: true         # tidy up after merging
require-approval: true      # don't merge unreviewed work
```

The full list, with defaults, is in [`examples/pr-scheduler-config.yml`](examples/pr-scheduler-config.yml)
and [`docs/configuration.md`](docs/configuration.md). Action inputs override the file, so you can also
set any of it in the workflow:

```yaml
      - uses: jaydenireland/PRSchedulerGratis@v1
        with:
          merge-method: squash
          require-approval: true
```

## How it works

Two halves, both running in your repository:

1. **Someone comments.** The `issue_comment` run parses the command, checks the commenter has write
   access, and records the schedule in the bot's own status comment — as a JSON payload inside an
   HTML comment, invisible when rendered. The pull request gets a `scheduled-merge` label.
2. **The cron runs.** Every five minutes, a sweep lists pull requests carrying that label, reads
   their schedules back, and merges the ones whose time has come.

There is no database and no server. The comment thread *is* the state, which means you can read the
whole schedule in the GitHub UI, and uninstalling leaves nothing behind but comments.

If a due pull request isn't ready — checks still running, still a draft, mergeability not yet
computed — the bot says what it's waiting for and keeps trying until the grace period (two hours by
default) runs out. Merge conflicts and closed pull requests are given up on immediately, since
waiting won't help.

More detail in [`docs/how-it-works.md`](docs/how-it-works.md).

## Permissions and safety

- **Only people with `write` access can schedule a merge.** Anyone else gets a polite refusal.
  Configurable via `minimum-permission`, but be careful lowering it: scheduling a merge is merging.
- **Permission is checked twice** — when the command is given, and again at merge time. Access
  revoked in between means no merge.
- **Settings are read from the base branch**, never from the pull request's own head, so a pull
  request can't relax the rules that govern merging it.
- **The merge is pinned to the commit that was checked.** If someone pushes between the readiness
  check and the merge, the merge is refused and retried rather than merging code nothing looked at.
- **The action never checks out pull request code**, so a fork can't run anything in your repository.
- Commands inside code fences and quoted replies are ignored, so pasting an example doesn't schedule
  a merge.

## Things worth knowing

**Cron is approximate.** GitHub runs scheduled workflows on a best-effort basis and delays them under
load, especially on the hour. A pull request merges on the first sweep *at or after* its time —
typically within a few minutes, occasionally longer. If you need something to land at exactly 09:00,
schedule it for 08:45.

**Scheduled workflows switch off in quiet repositories.** GitHub disables cron triggers after 60 days
with no commits. A repository you only publish to occasionally may need the workflow re-enabled from
the Actions tab.

**Merges made with `GITHUB_TOKEN` don't trigger other workflows.** This is a GitHub rule, not a
choice made here — and it matters if a deploy workflow is supposed to run when the post lands. See
[`docs/troubleshooting.md`](docs/troubleshooting.md#my-deploy-workflow-didnt-run-after-the-merge) for
the fix (a PAT or a GitHub App token). Pages sites built from a branch are unaffected.

**Only public repositories are free.** GitHub Actions minutes are free for public repositories and
metered for private ones. Each sweep is a few seconds; the arithmetic is in
[`docs/how-it-works.md`](docs/how-it-works.md#what-it-costs).

## Coming from the hosted app

The comment syntax is the same, so muscle memory carries over. What's different:

| | Hosted app | This |
| --- | --- | --- |
| Cost | $5–40/month | Free (Actions minutes) |
| Where it runs | Third-party servers | Your repository |
| Access to your code | Granted via app install | None beyond the workflow |
| Merge timing | Server-side timer | Cron sweep, best-effort |
| Merge method | Fixed | Configurable, per pull request |
| Cancel / status / help | — | Yes |
| Wait for checks | — | Yes, by default |

## Development

```bash
npm install
npm test          # 141 tests, no GitHub access needed
npm run build     # bundle src/ into dist/
```

`dist/index.js` is committed because GitHub Actions runs it directly — CI fails if it drifts from
`src/`. Run `npm run build` and commit the result with any source change.

Releases are cut as tags. `@v1` is a moving major tag repointed at each `v1.x` release, so
`uses: jaydenireland/PRSchedulerGratis@v1` picks up fixes without picking up breaking changes. Pin a
full tag (`@v1.0.0`) or a commit SHA if you'd rather freeze it.

The test suite covers the date parser, the command parser, config loading, the readiness rules and
each handler against an in-memory GitHub, plus an end-to-end test that runs the built bundle as a
real Actions process against a mock API.

## Licence

MIT — see [LICENSE](LICENSE).

Not affiliated with the PR Scheduler GitHub App or prscheduler.com.

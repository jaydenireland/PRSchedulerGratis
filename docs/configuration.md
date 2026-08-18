# Configuration

Every setting is optional. Defaults are chosen so that the action does something sensible with no
configuration at all.

Settings come from two places, and **action inputs win over the file**:

1. `.github/pr-scheduler.yml` in your repository (also read from `.github/pr-scheduler.yaml` or
   `.pr-scheduler.yml`)
2. `with:` inputs on the workflow step

The file is always read from the repository's default branch, never from a pull request's head
commit — otherwise a pull request could edit the rules that govern merging it.

Keys may be written `merge-method`, `merge_method` or `mergeMethod`. An unknown key or an invalid
value is reported as a workflow warning and the default is kept; a broken file never stops a merge
that was already scheduled.

## Settings

### `trigger`

Default: `@prscheduler`

The word that starts a command. Must be a single word with no whitespace.

```yaml
trigger: "/ship"
```

Then commands read `/ship 26/08/2026T11:05`. Useful if `@prscheduler` collides with a real username
in your organisation, or if you'd rather not use an `@`.

### `timezone`

Default: `UTC`

The timezone assumed when a comment doesn't name one. Accepts `UTC`, an IANA name
(`Europe/London`, `America/New_York`, `Australia/Sydney`), or a fixed offset (`GMT+5`, `UTC-03:30`).

```yaml
timezone: Europe/London
```

IANA names are the better choice: they follow daylight saving, so `09:00` stays 09:00 through the
March and October changes. A fixed offset does not.

A comment can always override this — `@prscheduler 26/08/2026T11:05 JST`.

### `merge-method`

Default: `merge`

One of `merge`, `squash` or `rebase`. The method must be enabled in your repository settings, or the
merge is refused. A comment can override it per pull request with `--squash`, `--rebase` or
`--merge`.

### `delete-branch`

Default: `false`

Delete the head branch after a scheduled merge. Branches on forks are never touched. Override per
pull request with `--delete-branch` or `--no-delete-branch`.

### `require-checks`

Default: `true`

Only merge when every check on the head commit has passed. Neutral and skipped results count as
passing; failing, timed-out, cancelled and action-required results do not.

A pull request that is due but not green is retried until `grace-period-minutes` runs out — a rerun
or a fix within that window still merges. Set to `false` to merge regardless, or use `--force` on a
single pull request.

This is not a substitute for branch protection. Branch protection is enforced by GitHub itself and
cannot be bypassed by a comment; this setting can.

### `require-approval`

Default: `false`

Only merge when at least one reviewer has approved and nobody has an outstanding request for
changes. Only each reviewer's most recent verdict counts, and a plain comment doesn't replace one.

### `minimum-permission`

Default: `write`

The repository permission needed to use any command except `help`: `read`, `triage`, `write`,
`maintain` or `admin`. `help` is answered for anyone.

Think hard before lowering this. Scheduling a merge *is* merging — `read` would let any passer-by on
a public repository merge to your default branch.

Permission is re-checked when the merge actually happens, so access revoked in the meantime stops
the merge.

### `label`, `label-color`, `label-description`

Defaults: `scheduled-merge`, `0e8a16`, `This pull request is queued for a scheduled merge`

The label that marks a pull request as queued. It's created automatically on first use, and it's how
the cron sweep finds work — so removing it by hand cancels the merge, and the next sweep tidies up.

```yaml
label: "⏰ scheduled"
label-color: "1d76db"
```

### `grace-period-minutes`

Default: `120`

How long to keep retrying a pull request that is due but not ready — checks still running, still a
draft, mergeability not yet computed. After this, the bot gives up and says what it was still
waiting for.

Problems that waiting can't fix — merge conflicts, a closed pull request, revoked permission — are
reported immediately rather than retried.

Raise it if your test suite is slow; a value of `0` means "merge on the first sweep or not at all".

### `max-schedule-days`

Default: `365`

The furthest ahead a merge may be scheduled. Anything further is refused with an explanation. Mostly
a guard against a typo in the year.

### `comment`

Default: `true`

Post status comments. With this off the action still works, but silently.

### `reactions`

Default: `true`

React to command comments — 👍 when a command is accepted, 😕 when it isn't understood, 👀 when it's
refused for lack of permission. Set to `false` for a quieter pull request.

## Action inputs

Every setting above is also an input, in kebab-case, plus:

| Input | Purpose |
| --- | --- |
| `token` | Token used to read comments and merge. Defaults to the workflow's `GITHUB_TOKEN`. Supply a PAT or GitHub App token if merges need to trigger other workflows. |
| `mode` | `auto` (default), `comment`, `sweep` or `closed`. `auto` picks from the event, which is what you want unless you're splitting the work across jobs. |
| `dry-run` | Log what would happen without commenting, labelling or merging. Handy for trying settings out. |

```yaml
      - uses: jaydenireland/PRSchedulerGratis@v1
        with:
          token: ${{ secrets.RELEASE_TOKEN }}
          merge-method: squash
          dry-run: ${{ github.ref != 'refs/heads/main' }}
```

## Outputs

| Output | Value |
| --- | --- |
| `action` | What the run did: `scheduled`, `rescheduled`, `cancelled`, `denied`, `error`, `help`, `status`, `sweep` or `skipped` |
| `scheduled-for` | ISO-8601 time a comment scheduled the merge for |
| `merged` | JSON array of pull request numbers a sweep merged |
| `processed` | How many scheduled pull requests a sweep looked at |

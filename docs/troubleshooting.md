# Troubleshooting

## The bot didn't reply to my comment

Check, in order:

1. **Is the workflow installed on the default branch?** `issue_comment` always runs the workflow file
   from the base branch. A workflow that only exists on a feature branch never fires.
2. **Does the workflow listen for `issue_comment`?** It needs `on: issue_comment: types: [created, edited]`.
3. **Is the trigger word right?** It's `@prscheduler` unless `trigger` is set in
   `.github/pr-scheduler.yml`.
4. **Is the command on its own line, at the start of it?** `Please @prscheduler 26/08/2026T11:05`
   won't fire — the trigger has to open the line.
5. **Is it inside a code fence or a quoted reply?** Those are deliberately ignored.
6. **Are Actions enabled for the repository?** Settings → Actions → General.

The Actions tab shows a run for every comment on a pull request. If there's no run at all, the
problem is the workflow trigger. If there's a run, its log says exactly what was parsed.

## It said I need write permission

Scheduling a merge is merging, so it needs `write` access to the repository. Repository owners and
organisation members with write access qualify; outside contributors don't, even on their own pull
request.

If that's wrong for your repository, lower `minimum-permission` — but understand what you're doing.
On a public repository, `read` lets anyone who can comment merge to your default branch.

## The scheduled time came and went

**Give it fifteen minutes.** GitHub's cron is best-effort and gets delayed under load. The merge
happens on the first sweep at or after the scheduled time.

Then check:

1. **Is the `schedule` trigger in the workflow?** Comment handling and the sweep are separate
   triggers; a workflow with only `issue_comment` will schedule merges and never perform them.
2. **Has GitHub disabled the cron?** Scheduled workflows switch off after 60 days without a commit.
   The Actions tab shows a banner, with a button to re-enable.
3. **Does the pull request still have the `scheduled-merge` label?** That's how the sweep finds it.
   If it was removed, the schedule is gone — comment a new time.
4. **What does the bot's comment say?** If it's waiting on something, it says so, and it says when
   it will give up.

## It's waiting on checks that already passed

The action looks at checks on the pull request's **head commit**. A check that ran against an older
commit doesn't count. Push an empty commit or rerun the checks against the current head.

If a check is stuck queued forever — a required check from a workflow that no longer runs, say — the
bot will wait out its grace period and then give up. Either fix the check or schedule with `--force`.

## It gave up because of conflicts

Merge conflicts can't be resolved by waiting, so the schedule is dropped immediately rather than
retried for two hours. Merge the base branch in, resolve, and comment a new time.

## My deploy workflow didn't run after the merge

This is the one that catches people, and it's a GitHub rule rather than a choice made here:

> When you use the repository's `GITHUB_TOKEN` to perform tasks, events triggered by that token will
> not create a new workflow run.

So a scheduled merge made with the default token **will not** trigger a `push` workflow — which
matters if that workflow is what builds and deploys your site.

Unaffected: GitHub Pages built directly from a branch, and anything else that watches the branch
rather than a workflow event.

To make the merge trigger downstream workflows, pass a token that isn't `GITHUB_TOKEN`:

```yaml
      - uses: jaydenireland/PRSchedulerGratis@v1
        with:
          token: ${{ secrets.RELEASE_TOKEN }}
```

Either a fine-grained personal access token with **Contents: read and write**, **Pull requests: read
and write** and **Issues: read and write** on the repository, or an installation token from a GitHub
App you own (`actions/create-github-app-token`). A GitHub App is the better choice for an
organisation — it isn't tied to one person's account.

## Two merges happened / it merged something unexpected

The action pins the merge to the head commit it checked, so a push landing mid-sweep causes a refusal
and a retry rather than an unexpected merge. Overlapping sweeps are prevented by the `concurrency`
block in the workflow — make sure you copied it:

```yaml
concurrency:
  group: pr-scheduler-${{ github.event.issue.number || github.event.pull_request.number || 'sweep' }}
  cancel-in-progress: false
```

## The time it scheduled isn't the time I meant

The format is **day first**: `05/04/2026` is 5 April. `2026-08-26T11:05` is also accepted if you'd
rather be unambiguous.

Times with no timezone are UTC unless `timezone` is set. The confirmation comment always shows the
resolved UTC time, and the requested local time next to it — check that first.

For a recurring publishing slot, prefer an IANA zone (`Europe/London`) over a fixed offset (`GMT+1`).
IANA zones follow daylight saving; offsets don't, so `GMT+1` drifts by an hour every October.

## How do I see what it would do, without it doing anything?

```yaml
      - uses: jaydenireland/PRSchedulerGratis@v1
        with:
          dry-run: true
```

Every comment, label and merge is logged instead of performed.

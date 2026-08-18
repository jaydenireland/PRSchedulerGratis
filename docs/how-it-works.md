# How it works

## The shape of it

PR Scheduler is one GitHub Action doing three jobs, chosen by the event that started it.

```
issue_comment  ──▶  read the command, record the schedule, label the pull request
schedule (cron) ─▶  find labelled pull requests that are due, and merge them
pull_request:closed ▶ clear a schedule that can no longer happen
```

Nothing runs between those events. There is no server, no database and no background process — which
is the whole reason this can be free.

## Where the schedule lives

In the bot's own comment.

When you schedule a merge, the action writes (or rewrites) a single status comment on the pull
request. Rendered, it's the confirmation you see. Underneath, it carries a JSON payload inside an
HTML comment, which GitHub renders as nothing:

```html
<!-- pr-scheduler:sticky -->
<!-- pr-scheduler:state {"v":1,"status":"scheduled","scheduledFor":"2026-08-26T11:05:00.000Z", ... } -->
### ⏰ Merge scheduled
- **Merging at:** Wed, 26 Aug 2026, 11:05 UTC (in 8 days)
...
```

The cron sweep reads that payload back. This has some pleasant consequences:

- The schedule is visible and auditable in the GitHub UI.
- Rescheduling edits one comment rather than adding another, so the thread stays readable.
- Uninstalling leaves nothing behind but comments — there's no state anywhere else.
- Hand-editing the payload into nonsense degrades to "nothing scheduled" rather than breaking.

The `scheduled-merge` label is the index. Without it the sweep would have to open every pull request
in the repository; with it, one filtered issue search returns the entire queue. Remove the label by
hand and the merge is cancelled — the next sweep notices the mismatch and tidies up.

## What happens at merge time

For each labelled pull request whose time has come:

1. **Read the schedule** from the sticky comment. No schedule, or one already merged or cancelled →
   drop the label and move on.
2. **Re-check the requester's permission.** Access granted a week ago may have been revoked since.
3. **Check the pull request is mergeable** — open, not a draft, no conflicts, and GitHub has finished
   working out whether the branches merge cleanly.
4. **Check the checks**, unless `require-checks` is off or the schedule was forced. Then reviews, if
   `require-approval` is on.
5. **Merge**, pinned to the exact head commit that was checked in steps 3 and 4.

Step 5 matters more than it looks. Passing the head SHA to the merge API means that if someone pushes
between the check and the merge, GitHub refuses it. The action then retries on the next sweep against
the new commit, rather than merging code that nothing ever looked at.

### When it isn't ready

Problems fall into two kinds.

**Wait and see** — checks running, checks failing, still a draft, mergeability unknown, GitHub
declining the merge for now. The bot updates its comment with what it's waiting for and tries again
on the next sweep, until `grace-period-minutes` (two hours by default) runs out. A rerun or a quick
fix inside that window still merges.

**Give up now** — merge conflicts, the pull request was closed, the requester lost write access.
Waiting can't fix these, so the bot reports the problem, drops the label and stops.

Either way you get one comment that says what happened. Nothing fails silently.

## Timing

The sweep runs on `cron: '*/5 * * * *'`, so a pull request merges on the first sweep **at or after**
its scheduled time. Two things stretch that gap:

- **GitHub's cron is best-effort.** Scheduled workflows are queued with low priority and get delayed
  under load — worst on the hour, when everyone's `0 * * * *` jobs fire at once. Delays of five to
  fifteen minutes are normal; longer happens.
- **Your sweep interval.** Five minutes is a reasonable default. A tighter cron doesn't help much,
  because GitHub's own delay dominates.

If something must land at exactly 09:00, schedule it a little early. If "some time Tuesday morning"
is fine — which is usually the case for a blog post — the default is fine.

Scheduled workflows are also **disabled automatically after 60 days without a commit**. A repository
you only publish to occasionally may need the workflow re-enabled from the Actions tab.

## Security

The threat to take seriously is that a comment triggers a merge, and comments come from anyone.

- **`issue_comment` runs on the base branch**, with that branch's workflow file and settings. A pull
  request cannot change what runs by editing the workflow, because its version is never used.
- **The action never checks out pull request code.** Nothing from a fork is executed.
- **Settings are read from the default branch**, so a pull request can't lower
  `minimum-permission` in its own diff and then merge itself.
- **Permission is verified against the API**, not inferred from `author_association`, and it's
  verified twice — at command time and again at merge time.
- **Commands in code fences and quoted replies are ignored**, so pasting an example into a comment,
  or quoting one in a reply, doesn't schedule anything.
- **The bot won't answer its own comments**, which is what stops a loop.

Branch protection still applies. The merge goes through the normal API with the workflow's token, so
required reviews, required checks and restricted-push rules are enforced by GitHub regardless of what
`.github/pr-scheduler.yml` says.

## What it costs

Public repositories: nothing. GitHub Actions is free for them.

Private repositories are metered, and the cron is the only part that runs continuously. At
`*/5 * * * *` that's 288 runs a day. Each is a checkout-free Node process making a handful of API
calls — a few seconds — but **Actions bills a one-minute minimum per job**, so budget one minute per
sweep:

| Sweep interval | Runs/day | Billed minutes/month |
| --- | --- | --- |
| `*/5 * * * *` | 288 | ~8,600 |
| `*/15 * * * *` | 96 | ~2,900 |
| `0 * * * *` | 24 | ~720 |

The free allowance on a private repository is 2,000 minutes a month on the Free plan and 3,000 on
Pro. So on a private repository, a five-minute sweep will cost money — use `*/15` or hourly, or
restrict the cron to the hours you actually publish in:

```yaml
  schedule:
    - cron: '*/10 8-18 * * 1-5'   # every ten minutes, working hours, weekdays
```

Comment-triggered runs are negligible either way: they only happen when someone comments.

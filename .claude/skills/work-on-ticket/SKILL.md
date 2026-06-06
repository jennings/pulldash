---
name: work-on-ticket
description: |
  Use when the user asks to work on a ticket, find the next ticket, pick
  up unblocked work, implement an issue, or claim a GitHub issue in this
  repo's ticket-driven workflow. Triggers: "work on a ticket", "what
  should I work on", "implement issue #N", "next ticket", "start a unit
  of work", "find unblocked work".
---

# Working on a ticket

Units of work in this repo are GitHub issues. Each unit follows this
loop: pick an unblocked ticket, claim it, implement it, verify it,
commit, and label it implemented. Merging the commit into `main` closes
the issue automatically — do not close issues manually.

## 1. Find a ticket

List candidates with `gh`. The filter is: open, not blocked, not already
in progress, not already implemented:

```bash
gh issue list \
  --state open \
  --search "-is:blocked -label:\"in progress\" -label:implemented" \
  --json number,title,labels,url
```

Prefer higher-priority tickets: `P1` > `P2` > `P3`. If multiple tickets
share the top priority, pick whichever has the clearest scope.

If no ticket exists yet for the unit of work the user is describing,
create one first — do not start without a ticket.

### Drilling into a tracking issue

If the chosen issue is a **tracking issue** (has sub-issues attached
via GitHub's native sub-issues feature), don't work it directly.
Read the sub-issues, pick an unblocked one using the same
priority/clarity criteria, and treat _that_ as the unit of work for
the rest of the loop.

```bash
gh api repos/:owner/:repo/issues/<n>/sub_issues \
  --jq '.[] | {number, title, state}'
```

A tracking issue with zero open sub-issues is itself the unit of
work — this is how single-ticket features planned via
`plan-tickets` show up.

## 2. Claim the ticket

Add the `in progress` label so others know it's taken:

```bash
gh issue edit <n> --add-label "in progress"
```

## 3. Implement

### Start the commit

Check whether `@` is already an empty working copy:

```bash
jj log -r @ --no-graph -T 'if(empty, "empty", "non-empty")'
```

- **`empty`** — reuse it. Set the ticket's commit message in place:

  ```bash
  jj describe -m "feat(area): short imperative title"
  ```

- **`non-empty`** — start a new commit on top:

  ```bash
  jj new -m "feat(area): short imperative title"
  ```

Always pass `-m`. `jj describe` / `jj new` / `jj squash` without a
message flag open `$EDITOR` and hang non-interactive sessions — see
`CLAUDE.local.md`.

One ticket per unit of work. A single ticket may span multiple commits,
but a single commit must not span multiple tickets.

**Do not push.** The user pushes manually.

## 4. Verify

Code must compile and tests must pass before the unit of work is done.
Per `BUILD.md`:

```bash
redo           # build
redo test      # build + run all unit tests
```

## 5. Commit message format

Once the work is verified, advance the working copy and update the commit
description to its final form with `jj commit -m "..."`. Follow the project's
style. Example:

```
feat(area): Short descriptive title here in imperative voice

Write a longer description here of the changes that were made and why.
Include lists, diagrams, tables, etc. if they help describe why this
change was made.

Resolves #123
```

Last line is either:

- `Resolves #123` — this commit completely finishes the ticket.
- `Progresses: #123` — there's more work to do on the ticket.

### Closing the tracking issue with the last sub-task

If the ticket has a parent tracking issue, check whether it's the
**last open sub-task** before writing the commit message:

```bash
# Find the parent (if any)
PARENT=$(gh api repos/:owner/:repo/issues/<n> --jq '.parent.number // empty')

# If there's a parent, count its other open sub-issues
if [ -n "$PARENT" ]; then
  gh api repos/:owner/:repo/issues/$PARENT/sub_issues \
    --jq '[.[] | select(.state=="open") | select(.number != <n>)] | length'
fi
```

If that count is `0`, the commit resolves **both** issues — add a
second `Resolves` line:

```
feat(area): Short imperative title

Body…

Resolves #<sub-task>
Resolves #<tracking>
```

Otherwise, just `Resolves #<sub-task>` as usual.

## 6. Finish

When the ticket is **completely implemented**:

```bash
gh issue edit <n> --add-label implemented --remove-label "in progress"
```

**Do not close the ticket.** Landing the commit on `main` closes it
automatically.

**Do not close the tracking issue manually either.** If this was
the last sub-task, the second `Resolves #<tracking>` line in the
commit message closes the parent when the commit lands on `main`.

### Leave a clean working copy

After labeling the ticket implemented, the working copy should be left on an
empty commit. The `jj commit` should have handled this, but if it didn't,
create a fresh empty commit on top so subsequent file edits don't accidentally
land in the ticket commit:

```bash
jj new
```

No message, no flags — this leaves `@` empty, ready for the next
ticket to either reuse via `jj describe` (Section 3) or branch from
via `jj new -m "..."`.

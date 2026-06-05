---
name: plan-tickets
description: |
  Use when the user asks to plan a feature or change by breaking it into
  GitHub Issues for this repo's ticket tracker. Triggers: "plan this
  feature", "break this into tickets", "create tickets for", "draft
  tickets", "what tickets do we need".
---

# Planning and creating tickets

The output of planning here is **GitHub Issues**, not code. Planning
ends when the tickets exist with priorities and dependencies set. Do
not begin implementing in the same session — implementation is a
separate ticket-driven loop (see the `work-on-ticket` skill).

Every planned feature lands as a single **top-level issue**. How that
issue is structured depends on size:

- **Single-ticket feature** — the top-level issue *is* the
  implementation ticket. Its body carries the implementation plan and
  `work-on-ticket` picks it up directly.
- **Multi-ticket feature** — the top-level issue is a **tracking
  issue**. The units of work are GitHub **sub-issues** attached via
  the native sub-issues API. The tracking issue stays open until the
  last sub-task's commit lands on `main`.

## 1. Design the plan

Break the work into tickets sized so each can be implemented in
roughly one commit and reviewed as one PR. If a ticket feels too
large to review in one sitting, split it.

Decide single vs. multi: does the feature fit in one commit-sized
ticket, or does it need to be broken up? If unsure, default to
single-ticket — splitting later is cheap.

For multi-ticket plans, identify which sub-tasks block which — the
dependency graph matters for prioritization.

## 2. Get user acceptance

Walk the user through the proposed shape (single ticket, or tracking
issue + sub-tasks) before writing anything to GitHub. Capture
corrections; do not create issues for a plan the user hasn't agreed
to.

## 3. Create the top-level issue

Always create this first.

```bash
gh issue create \
  --title "Imperative-voice title here" \
  --body  "Description of what the feature is and why" \
  --label P2
```

Title in imperative voice ("Add X", "Refactor Y", "Fix Z").

- **Single-ticket feature**: the body also contains the
  implementation plan — the detail that would have gone in a normal
  ticket. This issue *is* the work item. Skip to step 7 for the
  priority label, then stop.
- **Multi-ticket feature**: the body describes the feature and lists
  the planned sub-tasks as human-readable bullets (sub-issues will
  also render natively on the issue page). This issue is the
  tracking parent; it is not implemented directly. Continue to step
  4.

## 4. Create sub-task issues (multi-ticket only)

One `gh issue create` per commit-sized unit. Each sub-task body
should include the implementation detail for that unit and a
`Part of #<tracking>` line for grep-ability.

## 5. Link sub-tasks to the tracking issue (multi-ticket only)

Use GitHub's native sub-issues API so the parent renders the
sub-issue list and progress bar. The endpoint takes the sub-issue's
internal `id`, not its issue number:

```bash
# Look up the sub-issue's internal id
SUB_ID=$(gh api repos/:owner/:repo/issues/<sub_number> --jq '.id')

# Attach to the tracking issue
gh api repos/:owner/:repo/issues/<parent_number>/sub_issues \
  -f sub_issue_id=$SUB_ID
```

Docs: <https://docs.github.com/en/rest/issues/sub-issues>

## 6. Set ordering dependencies (multi-ticket only)

Sub-issues express *hierarchy*, not *order*. If sub-task B can't
start until sub-task A is done, also record that with the issue
dependencies API so `work-on-ticket`'s `-is:blocked` filter sees it.

Docs: <https://docs.github.com/en/rest/issues/issue-dependencies?apiVersion=2026-03-10>

## 7. Assign priority labels

- `P1` — bugs or critical features.
- `P2` — default.
- `P3` — nice-to-have.

Apply to the top-level issue and to every sub-task. For tracking
issues, the parent's priority should equal the highest priority
among its sub-tasks so it surfaces correctly in `work-on-ticket`'s
candidate list.

## 8. Stop

Planning is done once the tickets exist with priorities and
dependencies set, and (for multi-ticket features) sub-issues are
linked. **Do not begin implementing in the same session.** Hand the
work back to the user; they (or a future session via
`work-on-ticket`) will pick up implementation.

## Conventions

- Title in imperative voice ("Add X", "Refactor Y", "Fix Z").
- One sub-task per commit-sized unit of work.
- For single-ticket features, the top-level issue *is* the
  implementation issue — no separate sub-tasks.
- Tracking issues are **not** closed manually. The final sub-task's
  commit message resolves both the sub-task and the tracking issue
  (see `work-on-ticket`); landing on `main` closes both.

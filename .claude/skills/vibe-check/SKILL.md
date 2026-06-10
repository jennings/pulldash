---
name: vibe-check
description: |
  Use when the user asks to audit the codebase for AI-introduced smells,
  vibe-check the project, find code that needs cleanup, look for
  duplication / oversized components / unnecessary casts / unsynchronized
  state / untested behavior. Triggers: "vibe check", "vibe-check the
  codebase", "audit the code", "find AI smells", "what's rotten",
  "code health check".
---

# Vibe-checking the codebase

This skill sweeps the whole `src/` tree for architectural smells that
AI-written code tends to accumulate, reports them with file:line refs and
severity, then optionally hands findings to `plan-tickets` to file as GitHub
Issues. It does **not** apply fixes — see `/simplify` or `/code-review --fix`
for diff-scoped cleanup.

Accepts an optional path/glob argument to narrow scope; default is
`src/**/*.{ts,tsx}`.

## 1. Scope the audit

- Default: all `.ts` and `.tsx` files under `src/`, excluding `*.test.ts(x)`.
- If the user passes a path, restrict to that subtree.
- Skip the shadcn UI primitives in `src/browser/ui/` and any generated files
  unless the user explicitly includes them.

## 2. Run the checks

Fan out **parallel Explore sub-agents**, one per category, to keep the main
context lean. Each agent returns findings in the form:

```
file:line — evidence (one line)
Recommendation: one sentence
Severity: high | medium | low
```

### Check categories

**1. Duplicated logic**

Same algorithm or transformation implemented more than once. High-risk areas
in this codebase: diff parsing, line-number math, range/selection handling,
class-name composition. Look for near-identical functions in different files
and inline re-implementations of helpers that already exist in
`src/browser/lib/` or `src/api/`.

**2. Inconsistent library vs first-party utility use**

Places that hand-roll something the codebase already has a utility for:

- Class merging that bypasses `cn()` from `@/browser/cn` (clsx + tailwind-merge).
- Inline diff parsing when `src/api/diff.ts` or `src/browser/lib/diff.ts` applies.
- Raw `fetch` calls where `src/api/client.ts` should be used instead.

**3. Unnecessary TypeScript casts**

Grep for `as unknown as`, `: any`, and `as any` in non-test code. For each
hit, identify whether a structural fix (better type, discriminated union,
narrowing) would eliminate the cast. Known existing offenders to use as
baseline (do not re-flag these as new):

- `src/browser/contexts/github.tsx`
- `src/browser/components/file-tree.tsx`
- `src/browser/components/pr-overview.tsx`
- `src/browser/lib/diff-worker.ts`

Flag any that were added _since_ those files were last touched, or that appear
in files not on this list.

**4. Compiler-appeasing throws**

`throw new Error(...)` in branches the code never expects to execute —
especially in exhaustive switch/if chains, reducers, and store handlers. The
tell: the comment says "should never happen" or the branch has no meaningful
business logic. Recommend narrowing the type to eliminate the unreachable
branch rather than throwing.

**5. Oversized components and modules**

Flag any `.tsx` file over **500 lines**. Known outliers (high-severity by
default): `pr-overview.tsx` (~5000 lines), `pr-review.tsx` (~4300 lines),
`home.tsx` (~1600 lines), `welcome-dialog.tsx` (~1400 lines). For each, propose
concrete split points: sub-components, extracted hooks (`use*.ts`), or pure
helper modules.

**6. State duplicated and synchronized**

`useState` or `useRef` that holds a copy of data already in `GitHubStore`
(`src/browser/contexts/github.tsx`) or the `pr-review` context
(`src/browser/contexts/pr-review/`), kept in sync via `useEffect`. Recommend
a derived selector hook in `src/browser/contexts/pr-review/` instead.

**7. Important behavior with no test coverage**

For each significant module in `src/api/` and `src/browser/lib/`, verify a
sibling `*.test.ts(x)` exists and covers the obvious cases. Specifically flag:

- Error paths and empty-input handling.
- Boundary conditions in diff/interdiff/comment-grouping logic.
- Any module that has zero tests and is called from multiple places.

Also scan existing test files for `TODO`, `skip`, or `xtest` markers that
indicate intentionally-deferred coverage.

**8. Other smells**

- `catch {}` or `catch (e) {}` with no body (silent swallowing).
- Dead exports — symbols exported from a module but imported nowhere.
- `eslint-disable` comments outside generated or shadcn code.
- External libraries (`lodash`, `date-fns`, etc.) imported where a
  first-party helper or built-in would do.

## 3. Report findings

After all sub-agents return, print a consolidated markdown report:

```
## Vibe Check Report

### <Category Name>  (<count> findings)

- `src/path/to/file.tsx:42` — <evidence>
  Recommendation: <one sentence>
  Severity: high

...

---
## Summary

| Category | High | Medium | Low |
|---|---|---|---|
| Duplicated logic | … | … | … |
...

## Top 3 by impact

1. …
2. …
3. …
```

Sort findings within each category by severity (high first). Omit categories
with zero findings.

## 4. Offer to file tickets

After printing the report, ask the user which findings to convert into GitHub
Issues — they can reply with finding numbers, category names, "all high", or
"all".

For confirmed picks, invoke the **`plan-tickets`** skill, passing each finding
as a proposed ticket with:

- **Title**: a short imperative description of the smell.
- **Acceptance criterion**: the recommendation sentence from the finding.
- **Context**: the file:line evidence.

Do not re-implement issue creation here.

## Conventions

- This skill **does not edit code** and **does not run `jj` commands**.
  Its output is a report and optional ticket creation only.
- Use `bun typecheck` output as a free signal when checking for cast and
  compiler-appeasement smells; ESLint is configured in this project but not
  wired into `bun run`, so do not rely on it.
- File paths in the report must be repo-relative and include line numbers so
  the user can navigate directly.
- When severity is unclear, default to **medium** and note the uncertainty.

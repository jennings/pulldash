---
name: performance-audit
description: |
  Use when the user asks to audit the codebase for performance issues, find
  unnecessary re-renders, identify wasteful network requests, look for missing
  caching, find eager fetches or waterfall requests, detect expensive
  main-thread compute, or find code-splitting opportunities.
  Triggers: "performance audit", "audit performance", "find perf issues",
  "look for unnecessary re-renders", "check for duplicate requests",
  "find missing caching", "perf check", "why is the app slow".
---

# Performance audit

This skill sweeps `src/browser/` and `src/api/` for performance issues across
three domains — network, rendering, and compute/bundle — reports findings as a
single flat list sorted by impact (high → medium → low), then optionally hands
picks to `plan-tickets` to file as GitHub Issues. It does **not** apply fixes —
see `/simplify` or `/code-review --fix` for diff-scoped cleanup.

Accepts an optional path/glob argument to narrow scope; default is
`src/browser/**/*.{ts,tsx}` plus `src/api/**/*.ts`.

## 1. Scope the audit

- Default: `src/browser/**/*.{ts,tsx}` and `src/api/**/*.ts`, excluding
  `*.test.ts(x)` and the shadcn UI primitives in `src/browser/ui/`.
- If the user passes a path, restrict to that subtree.
- Include `src/browser/ui/` only if the user explicitly requests it.

## 2. Run the checks

Fan out **parallel Explore sub-agents**, one per category group, to keep the
main context lean. Each agent returns findings in the form:

```
file:line — evidence (one line)
Recommendation: one sentence
Impact: high | medium | low
Why: one-line rationale for the impact rating
```

Use the following impact rubric:

- **High** — runs on a hot path (every render of a top-level view, every
  navigation), or causes a user-perceptible delay or extra round-trip.
- **Medium** — runs on a warm path (open a dialog, switch tab) or wastes
  bandwidth/work but does not block paint.
- **Low** — cold path, micro-optimisation, or stylistic memoization gap.

When impact is unclear, default to **medium** and note the uncertainty in the
Why line.

### Check categories

**Network sub-agent**

1. **Duplicate requests** — the same API endpoint called multiple times for the
   same resource within a single render cycle or page navigation. Search call
   sites of `src/api/client.ts` exports; flag effects or handlers that
   re-fetch data a parent component already holds. Recommend deduplicating via
   a shared context value or caching.

2. **Missing cache use** — fetches for data that is stable per
   `(owner, repo, pr, sha)` but bypass `src/browser/lib/persistent-cache.ts`.
   For each hit, recommend a cache key pattern and invalidation rule.

3. **Eager or waterfall fetches** — requests fired on mount for data the
   current view does not yet render (e.g. full diff fetched before the user
   opens the diff tab), or sequential `await` chains that could run in
   parallel. Recommend lazy triggering or `Promise.all`.

**Rendering sub-agent**

4. **Unnecessary re-renders from unstable references** — context provider
   `value={{...}}` rebuilt on every render, inline object/array/function props
   passed to memoized children, `useMemo`/`useCallback` whose dep array
   contains a freshly-constructed object/array so the memo never hits.
   High-leverage targets: `src/browser/contexts/github.tsx` and
   `src/browser/contexts/pr-review/`.

5. **State updates that force a double render** — `setState` called
   unconditionally in the component body (banned by React), or
   `useEffect(() => setX(...), [])` with no condition that forces a second
   render on every mount. Recommend deriving the value during render, using a
   ref-initialized `useState`, or computing synchronously before the return.

6. **Large unvirtualized lists** — `.map()` rendering more than ~50 items
   without `@tanstack/react-virtual`. Reference the existing virtual-list
   pattern used in `src/browser/components/file-tree.tsx:252`,
   `src/browser/components/command-palette.tsx:235`, and
   `src/browser/components/pr-review.tsx:1888`.

7. **Over-broad context consumers** — components that call `useContext` (or a
   context hook) on a wide context object but only read one field, so they
   re-render on every unrelated context change. Recommend a selector hook
   in `src/browser/contexts/pr-review/` following the pattern of existing
   `use*.ts` hooks there.

**Compute & bundle sub-agent**

8. **Heavy synchronous compute on the render path** — diff/interdiff/range
   math running synchronously inside a component or sync effect that could be
   moved into `src/browser/lib/diff-worker.ts`, where the worker pattern
   already exists.

9. **No code-splitting** — zero use of `React.lazy`/`Suspense` anywhere in
   `src/`. Flag top-level route components and heavy dialogs as candidates,
   prioritising `src/browser/components/pr-overview.tsx` (~5 000 lines) and
   `src/browser/components/welcome-dialog.tsx` (~1 400 lines).

10. **Expensive recomputation with broken memoization** — `useMemo` over large
    arrays or heavy calculations where the dep array includes an object or
    array constructed inline (so the reference always changes and the memo
    never caches). Also flag computations done on every render that could be
    hoisted outside the component or initialised once.

## 3. Report findings

After all sub-agents return, print a single consolidated list:

```
## Performance Audit

1. [HIGH] [Rendering] `src/path/to/file.tsx:42` — <evidence>
   Recommendation: <one sentence>
   Why high: <rationale>

2. [HIGH] [Network] `src/path/to/api.ts:88` — <evidence>
   Recommendation: <one sentence>
   Why high: <rationale>

3. [MEDIUM] [Compute] `src/path/to/component.tsx:210` — <evidence>
   Recommendation: <one sentence>
   Why medium: <rationale>

…
```

- **One flat list**, sorted high → medium → low. No per-category sub-headers;
  the category tag on each item is sufficient.
- Omit a summary table.
- Omit categories or checks with zero findings.
- File paths must be repo-relative and include line numbers.

## 4. Ask which to file as tickets

After printing the list, prompt:

> Which of these would you like to file as tickets? Reply with item numbers,
> "all high", a category name, or "all".

For confirmed picks, invoke the **`plan-tickets`** skill, passing each finding
as a proposed ticket with:

- **Title**: short imperative (e.g. "Cache PR file list in persistent-cache",
  "Move interdiff compute into diff worker").
- **Acceptance criterion**: the recommendation sentence from the finding.
- **Context**: the file:line evidence and impact tag.

Do not re-implement issue creation here.

## Conventions

- This skill **does not edit code** and **does not run `jj` commands**. Its
  output is a report and optional ticket creation only.
- File paths in the report must be repo-relative and include line numbers so
  the user can navigate directly.
- Known large files (`pr-overview.tsx`, `pr-review.tsx`, `home.tsx`,
  `welcome-dialog.tsx`) are fair game — flag their specific perf costs, not
  just their size (size is already covered by `vibe-check`).
- Hand-off boundary: this skill does not implement fixes. Point the user at
  `/simplify` or `/code-review --fix` for diff-scoped cleanup, and
  `work-on-ticket` once a ticket is filed.

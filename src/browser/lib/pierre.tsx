import { useMemo } from "react";
import { canUseWASM, preloadHighlighter } from "@pierre/diffs";
import type { FileDiffOptions } from "@pierre/diffs/react";
import type {
  ExpansionDirections,
  HighlighterTypes,
  HunkExpansionRegion,
} from "@pierre/diffs";
import { useTheme } from "../contexts/theme";

/** Pierre's built-in themes; the app toggles between them with its own theme. */
export const DIFF_THEMES = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

export type DiffThemeType = "light" | "dark";

/**
 * Light/dark mode of the app (the `.dark`/`.light` class on <html>), for
 * Pierre's `themeType` option. Always explicit: Pierre's default `"system"`
 * follows the OS and would disagree with the app's manual theme toggle.
 */
export function useDiffThemeType(): DiffThemeType {
  return useTheme().theme;
}

/**
 * `highlights` (WebAssembly lexers, bundled in @pierre/highlights) wherever the
 * browser can run its WASM, Shiki's JS engine otherwise: Safari before 16.4
 * lacks the SIMD instructions Highlights needs, and a Content Security Policy
 * without `wasm-unsafe-eval` blocks it. `canUseWASM()` probes both.
 *
 * Highlighting runs on the main thread, deliberately without Pierre's worker
 * pool. Highlights tokenizes a 5,000-line file in a couple of milliseconds, far
 * less than a worker round trip (message copy of the rendered lines, plain text
 * painted first), and Pierre's own docs recommend against a pool for it. The
 * work is O(file) and covers the whole file, not just the visible lines, as
 * does the word diff (measured: ~63 ms for a 4.7k-line full rewrite, ~176 ms for
 * a 47k-line half-changed file); that is accepted. Only the Shiki fallback is
 * slow enough to want a worker, and it is rare enough not to justify a worker
 * build that every user would download and cache; `HIGHLIGHTER_OPTIONS`
 * bounds its main-thread work instead. Pierre keeps one backend per page; every
 * component passes this same value.
 */
export const PREFERRED_HIGHLIGHTER: HighlighterTypes = canUseWASM()
  ? "highlights"
  : "shiki-js";

/**
 * Shiki's JS engine takes ~350 ms for a 4,700-line file, so on the fallback
 * path files longer than this many lines render as plain text instead of
 * blocking the main thread. (Pierre's default limit is 100,000 lines.)
 */
const SHIKI_FALLBACK_MAX_LINES = 5_000;

/** Backend options every Pierre component takes; spread into its `options`. */
export const HIGHLIGHTER_OPTIONS: {
  preferredHighlighter: HighlighterTypes;
  tokenizeMaxLength?: number;
} =
  PREFERRED_HIGHLIGHTER === "shiki-js"
    ? {
        preferredHighlighter: PREFERRED_HIGHLIGHTER,
        tokenizeMaxLength: SHIKI_FALLBACK_MAX_LINES,
      }
    : { preferredHighlighter: PREFERRED_HIGHLIGHTER };

// Initialize the highlighter and load both themes as soon as the PR view's
// code is loaded, in parallel with the PR data fetch, so the first diff to
// render is usually already highlighted. Components retry and report failures
// themselves, so a failure here is not surfaced twice.
void preloadHighlighter({
  themes: [DIFF_THEMES.light, DIFF_THEMES.dark],
  langs: [],
  preferredHighlighter: PREFERRED_HIGHLIGHTER,
}).catch(() => {});

/**
 * Options for the small read-only diff snippets shown outside the diff panel
 * (review thread context in the overview). Memoized per theme: Pierre compares
 * options by reference and re-renders when they change.
 */
export function useSnippetDiffOptions(): FileDiffOptions<undefined, undefined> {
  const themeType = useDiffThemeType();
  return useMemo(
    () => ({
      theme: DIFF_THEMES,
      themeType,
      diffStyle: "unified",
      disableFileHeader: true,
      hunkSeparators: "simple",
      overflow: "scroll",
      lineDiffType: "word-alt",
      ...HIGHLIGHTER_OPTIONS,
    }),
    [themeType]
  );
}

/** What the diff viewer uses of the per-file instance Pierre's `CodeView` passes to `onPostRender`. */
export interface DiffInstance {
  expandHunk(
    hunkIndex: number,
    direction: ExpansionDirections,
    expansionLineCountOverride?: number
  ): void;
}

/** CodeView also renders files; only diff instances can expand hunks. */
export function isDiffInstance(instance: object): instance is DiffInstance {
  return "expandHunk" in instance;
}

/**
 * The hunk-expansion state of a rendered diff, keyed by hunk index (see
 * `DiffExpansion` in file-diff.ts).
 *
 * Pierre keeps this map inside the instance's `hunksRenderer`, which its
 * typings mark `protected`, and exposes no public way to read it. Expansion
 * happens inside Pierre (separator buttons, `expandHunk`), so this is the only
 * place to learn about it. `@pierre/diffs` is therefore pinned to an exact
 * version: re-check this accessor when upgrading.
 *
 * Returns Pierre's live map; copy it before keeping it.
 */
export function readDiffExpansion(
  instance: DiffInstance
): ReadonlyMap<number, HunkExpansionRegion> {
  const renderer = (
    instance as unknown as {
      hunksRenderer: {
        getExpandedHunksMap(): Map<number, HunkExpansionRegion>;
      };
    }
  ).hunksRenderer;
  return renderer.getExpandedHunksMap();
}

import { useMemo, type ReactNode } from "react";
import {
  WorkerPoolContextProvider,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from "@pierre/diffs/react";
import type { FileDiffOptions } from "@pierre/diffs/react";
import type { ExpansionDirections, HunkExpansionRegion } from "@pierre/diffs";
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
 * Pierre's highlighter runs in a pool of module workers. The worker is bundled
 * by `scripts/build-browser.ts`, which injects its URL; the fallback only
 * matters when the sources are served without that build step.
 */
function createPierreWorker(): Worker {
  return new Worker(
    typeof __PIERRE_WORKER_URL__ === "undefined"
      ? "/pierre/worker.js"
      : __PIERRE_WORKER_URL__,
    { type: "module" }
  );
}

const POOL_SIZE = Math.max(
  1,
  Math.min(4, (navigator.hardwareConcurrency || 2) - 1)
);

export const pierrePoolOptions: WorkerPoolOptions = {
  workerFactory: createPierreWorker,
  poolSize: POOL_SIZE,
};

/**
 * With a worker pool, `theme` and `lineDiffType` are owned by the pool, not
 * the individual components.
 */
export const pierreHighlighterOptions: WorkerInitializationRenderOptions = {
  theme: DIFF_THEMES,
  lineDiffType: "word-alt",
};

/** Mount once near the app root; all Pierre components below share the pool. */
export function PierreProvider({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider
      poolOptions={pierrePoolOptions}
      highlighterOptions={pierreHighlighterOptions}
    >
      {children}
    </WorkerPoolContextProvider>
  );
}

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

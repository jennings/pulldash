// CSS for what the diff viewer adds on top of Pierre's rendering: comment
// markers, the focused gap and search highlights. Selectors are keyed on
// Pierre's line data attributes, so they apply to virtualized lines the moment
// those render.
//
// Two stylesheets: `STATIC_CSS` goes through Pierre's `unsafeCSS` option, which
// must never change (a different value makes Pierre drop its layout cache);
// the per-state rules from `buildDecorationCss` live in a stylesheet the viewer
// adopts into each diff's shadow root.

import { DIFF_COLORS_CSS } from "../../lib/diff-colors";
import type { DiffRow } from "../../lib/file-diff";
import type { LineSide } from "./selection";

export type DiffViewStyle = "unified" | "split";

/** `CSS.highlights` names for search matches. */
export const SEARCH_HIGHLIGHT = "pd-search";
export const SEARCH_HIGHLIGHT_ACTIVE = "pd-search-active";

const BLUE = "59 130 246";

/** Constant rules (diff colors, search highlights). */
export const STATIC_CSS = `${DIFF_COLORS_CSS}
::highlight(${SEARCH_HIGHLIGHT}) { background-color: light-dark(#fde047, rgb(234 179 8 / 0.6)); color: inherit; }
::highlight(${SEARCH_HIGHLIGHT_ACTIVE}) { background-color: light-dark(#fdba74, rgb(249 115 22 / 0.7)); color: inherit; }
`;

interface LineScope {
  line: string;
  number: string;
}

/**
 * Selector prefix for the code on `side`. A unified diff shows a line once,
 * keyed by its new number unless it is a deletion; a split diff has one column
 * per side.
 */
function lineScope(
  style: DiffViewStyle,
  side: LineSide,
  line: number
): LineScope {
  if (style === "split") {
    const column = side === "old" ? "[data-deletions]" : "[data-additions]";
    return {
      line: `${column} [data-line="${line}"]`,
      number: `${column} [data-column-number="${line}"]`,
    };
  }
  const type =
    side === "old"
      ? '[data-line-type="change-deletion"]'
      : ':not([data-line-type="change-deletion"])';
  return {
    line: `[data-unified] [data-line="${line}"]${type}`,
    number: `[data-unified] [data-column-number="${line}"]${type}`,
  };
}

/**
 * Where an old-side line is drawn. In a split diff and for deletions that is
 * the old line number; in a unified diff a context line is drawn once, under
 * its new number.
 */
function scopesFor(
  style: DiffViewStyle,
  side: LineSide,
  line: number,
  newLineOfContext: ReadonlyMap<number, number>
): LineScope[] {
  const scopes = [lineScope(style, side, line)];
  const moved = side === "old" ? newLineOfContext.get(line) : undefined;
  if (style === "unified" && moved !== undefined) {
    scopes.push(lineScope(style, "new", moved));
  }
  return scopes;
}

/** Old line number -> new line number of the context rows. */
function contextLineMap(rows: readonly DiffRow[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of rows) {
    if (
      row.kind === "line" &&
      row.type === "context" &&
      row.oldLine !== null &&
      row.newLine !== null
    ) {
      map.set(row.oldLine, row.newLine);
    }
  }
  return map;
}

const parseKey = (key: string): [number, LineSide] => {
  const [line, side] = key.split(":");
  return [Number(line), side as LineSide];
};

export interface DecorationInput {
  style: DiffViewStyle;
  /** Rows as shown; maps old-side lines of unified context rows. */
  rows: readonly DiffRow[];
  /** `"line:side"` of lines inside a comment's range. */
  rangeLines: ReadonlySet<string>;
  /** Line numbers with an unsaved comment draft. */
  draftLines: ReadonlySet<number>;
  /** Hunk index of the gap with keyboard focus. */
  focusedGap: number | null;
}

/** Rules for the current comment and focus state. */
export function buildDecorationCss({
  style,
  rows,
  rangeLines,
  draftLines,
  focusedGap,
}: DecorationInput): string {
  const rules: string[] = [];
  const contextLines =
    style === "unified" && rangeLines.size > 0
      ? contextLineMap(rows)
      : new Map<number, number>();
  // Drafts carry no side, so their numbers are not remapped from old to new.
  const noRemap = new Map<number, number>();

  // Lines a comment covers: a dotted-blue edge on the line number.
  for (const key of rangeLines) {
    const [line, side] = parseKey(key);
    for (const scope of scopesFor(style, side, line, contextLines)) {
      rules.push(
        `${scope.number} { box-shadow: inset 2px 0 0 0 rgb(${BLUE} / 0.55); }`
      );
    }
  }

  // Unsaved draft: an amber dot, on whichever side the line number is shown.
  for (const line of draftLines) {
    for (const side of ["old", "new"] as const) {
      for (const scope of scopesFor(style, side, line, noRemap)) {
        rules.push(
          `${scope.number}::after { content: ""; position: absolute; left: 3px; top: 50%; width: 6px; height: 6px; border-radius: 9999px; transform: translateY(-50%); background-color: rgb(251 191 36); }`
        );
      }
    }
  }

  if (focusedGap !== null) {
    rules.push(
      `[data-separator][data-expand-index="${focusedGap}"] { outline: 2px solid rgb(${BLUE}); outline-offset: -2px; background-color: rgb(${BLUE} / 0.12); }`
    );
  }

  return rules.join("\n");
}

/**
 * Line numbers of `path` that have a non-empty draft. Draft keys are
 * `"${path}:${endLine}:${startLine ?? ""}"`, so the line is taken from the end
 * (file paths may contain ":").
 */
export function draftLinesFor(
  drafts: Readonly<Record<string, string>>,
  path: string
): Set<number> {
  const lines = new Set<number>();
  for (const [key, text] of Object.entries(drafts)) {
    if (!key.startsWith(`${path}:`) || !text.trim()) continue;
    const lineEnd = key.lastIndexOf(":");
    const lineStart = key.lastIndexOf(":", lineEnd - 1);
    const line = Number(key.slice(lineStart + 1, lineEnd));
    if (Number.isInteger(line) && line > 0) lines.add(line);
  }
  return lines;
}

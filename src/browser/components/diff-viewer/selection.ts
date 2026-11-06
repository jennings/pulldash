// Pure mapping between the review store's line focus/selection (old/new
// line numbers) and Pierre's selection and annotation model (`deletions` /
// `additions` sides). The viewer is a thin shell around these functions.

import type {
  AnnotationSide,
  SelectedLineRange,
  SelectionSide,
} from "@pierre/diffs";
import type { DiffRow } from "../../lib/file-diff";

export type LineSide = "old" | "new";

export function toPierreSide(side: LineSide): AnnotationSide {
  return side === "old" ? "deletions" : "additions";
}

export function fromPierreSide(side: SelectionSide | undefined): LineSide {
  return side === "deletions" ? "old" : "new";
}

export interface FocusState {
  focusedLine: number | null;
  focusedLineSide: LineSide | null;
  selectionAnchor: number | null;
  selectionAnchorSide: LineSide | null;
}

/**
 * The store's focus as a Pierre selection: the focused line, or the whole
 * range when an anchor on the same side exists. Direction is preserved
 * (`start` is the anchor) so extending a selection keeps its anchor.
 */
export function focusToRange(state: FocusState): SelectedLineRange | null {
  const { focusedLine, focusedLineSide: side } = state;
  if (focusedLine === null || side === null) return null;
  const pierreSide = toPierreSide(side);
  const anchor =
    state.selectionAnchor !== null && state.selectionAnchorSide === side
      ? state.selectionAnchor
      : focusedLine;
  return {
    start: anchor,
    side: pierreSide,
    end: focusedLine,
    endSide: pierreSide,
  };
}

export interface RangeFocus {
  focusedLine: number;
  focusedLineSide: LineSide;
  selectionAnchor: number | null;
}

/**
 * A Pierre selection as store focus. Selections are same-side only: a drag
 * that ended on the other column of a split diff collapses to its first line.
 */
export function rangeToFocus(
  range: SelectedLineRange | null
): RangeFocus | null {
  if (!range) return null;
  const side = fromPierreSide(range.side);
  const crossSide = range.endSide !== undefined && range.endSide !== range.side;
  const end = crossSide ? range.start : range.end;
  return {
    focusedLine: end,
    focusedLineSide: side,
    selectionAnchor: range.start === end ? null : range.start,
  };
}

export interface CommentTarget {
  line: number;
  startLine?: number;
  side: LineSide;
}

/** Where a comment on `range` goes: the last line, plus the first for ranges. */
export function rangeToCommentTarget(
  range: SelectedLineRange | null
): CommentTarget | null {
  const focus = rangeToFocus(range);
  if (!focus) return null;
  return commentTarget(
    focus.focusedLine,
    focus.selectionAnchor,
    focus.focusedLineSide
  );
}

export function commentTarget(
  focusedLine: number,
  anchor: number | null,
  side: LineSide
): CommentTarget {
  const start = anchor === null ? focusedLine : Math.min(anchor, focusedLine);
  const end = anchor === null ? focusedLine : Math.max(anchor, focusedLine);
  return start === end
    ? { line: end, side }
    : { line: end, startLine: start, side };
}

export interface ExtendSelection {
  /** Anchor to record first, when the store had none. */
  anchor: { line: number; side: LineSide } | null;
  focus: { line: number; side: LineSide };
  comment: CommentTarget;
}

/**
 * Shift/Cmd-click on `line`: extend the selection from the current focus (or
 * its anchor) to the clicked line and comment on the result. Null when there
 * is no focus to extend from.
 */
export function extendSelection(
  state: FocusState,
  line: number,
  side: LineSide
): ExtendSelection | null {
  if (state.focusedLine === null) return null;
  const anchorLine = state.selectionAnchor ?? state.focusedLine;
  return {
    anchor:
      state.selectionAnchor === null
        ? { line: state.focusedLine, side: state.focusedLineSide ?? side }
        : null,
    focus: { line, side },
    comment: commentTarget(line, anchorLine, side),
  };
}

/** Text of the new-side lines `start..end`, for a "suggest change" block. */
export function newSideLines(
  rows: readonly DiffRow[],
  start: number,
  end: number
): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.kind !== "line" || row.newLine === null) continue;
    if (row.newLine >= start && row.newLine <= end) lines.push(row.text);
  }
  return lines;
}

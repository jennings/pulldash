import { expect, test } from "bun:test";
import type { DiffRow } from "../../lib/file-diff";
import {
  extendSelection,
  focusToRange,
  newSideLines,
  rangeToCommentTarget,
  rangeToFocus,
  type FocusState,
} from "./selection";

const focus = (partial: Partial<FocusState>): FocusState => ({
  focusedLine: null,
  focusedLineSide: null,
  selectionAnchor: null,
  selectionAnchorSide: null,
  ...partial,
});

test("focusToRange maps the focused line, and a same-side anchor, to a Pierre range", () => {
  expect(focusToRange(focus({}))).toBeNull();
  expect(
    focusToRange(focus({ focusedLine: 7, focusedLineSide: "new" }))
  ).toEqual({ start: 7, side: "additions", end: 7, endSide: "additions" });
  // The anchor stays the start, even when the selection grows upwards.
  expect(
    focusToRange(
      focus({
        focusedLine: 4,
        focusedLineSide: "old",
        selectionAnchor: 9,
        selectionAnchorSide: "old",
      })
    )
  ).toEqual({ start: 9, side: "deletions", end: 4, endSide: "deletions" });
  // An anchor on the other side is not part of this selection.
  expect(
    focusToRange(
      focus({
        focusedLine: 4,
        focusedLineSide: "new",
        selectionAnchor: 9,
        selectionAnchorSide: "old",
      })
    )
  ).toEqual({ start: 4, side: "additions", end: 4, endSide: "additions" });
});

test("rangeToFocus turns Pierre selections into store focus and collapses cross-side drags", () => {
  expect(rangeToFocus(null)).toBeNull();
  expect(
    rangeToFocus({ start: 3, side: "additions", end: 3, endSide: "additions" })
  ).toEqual({ focusedLine: 3, focusedLineSide: "new", selectionAnchor: null });
  expect(
    rangeToFocus({ start: 8, side: "deletions", end: 5, endSide: "deletions" })
  ).toEqual({ focusedLine: 5, focusedLineSide: "old", selectionAnchor: 8 });
  expect(
    rangeToFocus({ start: 8, side: "deletions", end: 12, endSide: "additions" })
  ).toEqual({ focusedLine: 8, focusedLineSide: "old", selectionAnchor: null });
  // A range without sides is on the new side.
  expect(rangeToFocus({ start: 2, end: 4 })).toEqual({
    focusedLine: 4,
    focusedLineSide: "new",
    selectionAnchor: 2,
  });
});

test("rangeToCommentTarget comments on the last line and records the first for ranges", () => {
  expect(rangeToCommentTarget(null)).toBeNull();
  expect(rangeToCommentTarget({ start: 6, side: "additions", end: 6 })).toEqual(
    { line: 6, side: "new" }
  );
  expect(
    rangeToCommentTarget({
      start: 12,
      side: "deletions",
      end: 10,
      endSide: "deletions",
    })
  ).toEqual({ line: 12, startLine: 10, side: "old" });
});

test("extendSelection extends from the focus, recording its anchor once", () => {
  expect(extendSelection(focus({}), 5, "new")).toBeNull();
  expect(
    extendSelection(
      focus({ focusedLine: 10, focusedLineSide: "new" }),
      4,
      "new"
    )
  ).toEqual({
    anchor: { line: 10, side: "new" },
    focus: { line: 4, side: "new" },
    comment: { line: 10, startLine: 4, side: "new" },
  });
  expect(
    extendSelection(
      focus({
        focusedLine: 12,
        focusedLineSide: "new",
        selectionAnchor: 8,
        selectionAnchorSide: "new",
      }),
      20,
      "new"
    )
  ).toEqual({
    anchor: null,
    focus: { line: 20, side: "new" },
    comment: { line: 20, startLine: 8, side: "new" },
  });
  expect(
    extendSelection(focus({ focusedLine: 5, focusedLineSide: "new" }), 5, "new")
      ?.comment
  ).toEqual({ line: 5, side: "new" });
});

test("newSideLines returns the text of new-side lines in range, in order", () => {
  const rows: DiffRow[] = [
    {
      kind: "line",
      type: "context",
      oldLine: 1,
      newLine: 1,
      text: "a",
      hunkIndex: 0,
    },
    {
      kind: "line",
      type: "deletion",
      oldLine: 2,
      newLine: null,
      text: "b",
      hunkIndex: 0,
    },
    {
      kind: "line",
      type: "addition",
      oldLine: null,
      newLine: 2,
      text: "c",
      hunkIndex: 0,
    },
    { kind: "gap", hunkIndex: 1, count: 5, oldStart: 3, newStart: 3 },
    {
      kind: "line",
      type: "context",
      oldLine: 8,
      newLine: 8,
      text: "d",
      hunkIndex: 1,
    },
  ];
  expect(newSideLines(rows, 1, 2)).toEqual(["a", "c"]);
  expect(newSideLines(rows, 3, 7)).toEqual([]);
});

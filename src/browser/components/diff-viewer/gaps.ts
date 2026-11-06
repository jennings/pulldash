// Lookups over a file's display rows (`diffRows`): is a line visible, which
// collapsed gap hides it, and where to scroll to bring a gap into view.

import type { AnnotationSide } from "@pierre/diffs";
import type { DiffExpansion, DiffRow } from "../../lib/file-diff";
import type { LineSide } from "./selection";

export type GapRow = Extract<DiffRow, { kind: "gap" }>;

/** The line is shown (not hidden in a collapsed gap). */
export function hasVisibleLine(
  rows: readonly DiffRow[],
  side: LineSide,
  line: number
): boolean {
  return rows.some(
    (row) =>
      row.kind === "line" &&
      (side === "old" ? row.oldLine : row.newLine) === line
  );
}

/** The collapsed gap hiding `line` on `side`, if any. */
export function findGapHiding(
  rows: readonly DiffRow[],
  side: LineSide,
  line: number
): GapRow | null {
  for (const row of rows) {
    if (row.kind !== "gap") continue;
    const start = side === "old" ? row.oldStart : row.newStart;
    if (line >= start && line < start + row.count) return row;
  }
  return null;
}

/** The collapsed gap that precedes hunk `hunkIndex` (its expansion key). */
export function findGap(
  rows: readonly DiffRow[],
  hunkIndex: number
): GapRow | null {
  for (const row of rows) {
    if (row.kind === "gap" && row.hunkIndex === hunkIndex) return row;
  }
  return null;
}

/**
 * A visible line next to a gap, to scroll to when the gap itself cannot be
 * addressed: the first line after it, or the last before it for a trailing
 * gap.
 */
export function lineNextToGap(
  rows: readonly DiffRow[],
  gap: GapRow
): { lineNumber: number; side: AnnotationSide } | null {
  const index = rows.indexOf(gap);
  if (index === -1) return null;
  const pick = (row: DiffRow | undefined) =>
    row?.kind === "line" && row.newLine !== null
      ? { lineNumber: row.newLine, side: "additions" as const }
      : row?.kind === "line" && row.oldLine !== null
        ? { lineNumber: row.oldLine, side: "deletions" as const }
        : null;
  return pick(rows[index + 1]) ?? pick(rows[index - 1]);
}

/** Both maps expand the same regions by the same amounts. */
export function sameExpansion(a: DiffExpansion, b: DiffExpansion): boolean {
  if (a.size !== b.size) return false;
  for (const [key, region] of a) {
    const other = b.get(key);
    if (
      !other ||
      other.fromStart !== region.fromStart ||
      other.fromEnd !== region.fromEnd
    ) {
      return false;
    }
  }
  return true;
}

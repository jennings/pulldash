import type { DiffRow } from "./file-diff";

/** A keyboard-focusable row of the unified view: a line or a collapsed gap. */
export type NavItem =
  | { type: "line"; lineNum: number; side: "old" | "new" }
  | { type: "gap"; hunkIndex: number };

/**
 * Focusable items in unified display order. A deleted line is focused on the
 * old side; every other line (context, addition) on the new side.
 */
export function navItems(rows: readonly DiffRow[]): NavItem[] {
  return rows.map((row): NavItem => {
    if (row.kind === "gap") return { type: "gap", hunkIndex: row.hunkIndex };
    return row.type === "deletion"
      ? { type: "line", lineNum: row.oldLine!, side: "old" }
      : { type: "line", lineNum: row.newLine!, side: "new" };
  });
}

/** A visual row of the split view; a side is null where it has no line. */
export type SplitItem =
  | { type: "pair"; oldLine: number | null; newLine: number | null }
  | { type: "gap"; hunkIndex: number };

/**
 * Rows of the split view: context on both sides, a change block's deletions
 * and additions paired up by position (the shorter side stays empty).
 */
export function splitItems(rows: readonly DiffRow[]): SplitItem[] {
  const items: SplitItem[] = [];
  for (let i = 0; i < rows.length; ) {
    const row = rows[i]!;
    if (row.kind === "gap") {
      items.push({ type: "gap", hunkIndex: row.hunkIndex });
      i++;
    } else if (row.type === "context") {
      items.push({ type: "pair", oldLine: row.oldLine, newLine: row.newLine });
      i++;
    } else {
      const deletions: number[] = [];
      const additions: number[] = [];
      for (; i < rows.length; i++) {
        const next = rows[i]!;
        if (next.kind !== "line" || next.type === "context") break;
        if (next.type === "deletion") {
          if (additions.length > 0) break;
          deletions.push(next.oldLine!);
        } else {
          additions.push(next.newLine!);
        }
      }
      const count = Math.max(deletions.length, additions.length);
      for (let j = 0; j < count; j++) {
        items.push({
          type: "pair",
          oldLine: deletions[j] ?? null,
          newLine: additions[j] ?? null,
        });
      }
    }
  }
  return items;
}

/**
 * The line to focus for a goto-line request, or null when the file has no
 * lines. `column` is the line-number column the user typed a number for; the
 * closest line number in that column wins.
 *
 * In the unified view a context line can only be focused on the new side, so
 * a number typed for the old column resolves to that line's new-side focus.
 */
export function gotoLineTarget(
  rows: readonly DiffRow[],
  target: number,
  column: "old" | "new",
  viewMode: "unified" | "split"
): { line: number; side: "old" | "new" } | null {
  let best: { distance: number; line: number; side: "old" | "new" } | null =
    null;
  for (const row of rows) {
    if (row.kind !== "line") continue;
    const number = column === "old" ? row.oldLine : row.newLine;
    if (number === null) continue;
    let focus: { line: number; side: "old" | "new" };
    if (row.type === "deletion") {
      focus = { line: row.oldLine!, side: "old" };
    } else if (column === "old" && viewMode === "split") {
      focus = { line: row.oldLine!, side: "old" };
    } else {
      focus = { line: row.newLine!, side: "new" };
    }
    const distance = Math.abs(number - target);
    if (best === null || distance < best.distance)
      best = { distance, ...focus };
  }
  return best && { line: best.line, side: best.side };
}

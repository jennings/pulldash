// Helpers for working with the lines Pierre has rendered into its shadow DOM:
// which side a rendered line is on, and how character offsets in a line map
// onto its text nodes.

import type { LineSide } from "./selection";

/** Which `<code data-code>` column a rendered line sits in. */
export type CodeColumn = "unified" | "additions" | "deletions";

/**
 * Side of a rendered line. A unified column shows each line once: deletions
 * carry their old number, everything else (including context) its new one.
 */
export function renderedLineSide(
  column: CodeColumn,
  lineType: string | undefined
): LineSide {
  if (column === "deletions") return "old";
  if (column === "additions") return "new";
  return lineType === "change-deletion" ? "old" : "new";
}

function columnOf(code: HTMLElement): CodeColumn | null {
  if ("unified" in code.dataset) return "unified";
  if ("additions" in code.dataset) return "additions";
  if ("deletions" in code.dataset) return "deletions";
  return null;
}

/**
 * Visit rendered line elements (`[data-line]` for code, or
 * `[data-column-number]` for line numbers) with their side and number.
 */
export function forEachRenderedLine(
  root: ParentNode,
  selector: "[data-line]" | "[data-column-number]",
  visit: (element: HTMLElement, side: LineSide, line: number) => void
): void {
  for (const code of root.querySelectorAll<HTMLElement>("[data-code]")) {
    const column = columnOf(code);
    if (!column) continue;
    for (const element of code.querySelectorAll<HTMLElement>(selector)) {
      const line = Number(
        selector === "[data-line]"
          ? element.dataset.line
          : element.dataset.columnNumber
      );
      if (!Number.isInteger(line)) continue;
      visit(element, renderedLineSide(column, element.dataset.lineType), line);
    }
  }
}

export interface TextRangeBounds {
  startNode: number;
  startOffset: number;
  endNode: number;
  endOffset: number;
}

/**
 * Map `[start, end)` character offsets of a line onto its text nodes (given
 * by their lengths, in order). Null when the span is empty or past the text.
 */
export function locateTextRange(
  lengths: readonly number[],
  start: number,
  end: number
): TextRangeBounds | null {
  if (end <= start) return null;
  let startNode = -1;
  let startOffset = 0;
  let endNode = -1;
  let endOffset = 0;
  let consumed = 0;
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i];
    if (startNode === -1 && start < consumed + length) {
      startNode = i;
      startOffset = start - consumed;
    }
    if (startNode !== -1 && end <= consumed + length) {
      endNode = i;
      endOffset = end - consumed;
      break;
    }
    consumed += length;
  }
  if (startNode === -1) return null;
  if (endNode === -1) {
    // `end` runs past the text: clamp to its last node.
    endNode = lengths.length - 1;
    endOffset = lengths[endNode];
  }
  return { startNode, startOffset, endNode, endOffset };
}

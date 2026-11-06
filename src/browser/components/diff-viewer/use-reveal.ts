import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { DiffRow } from "../../lib/file-diff";
import type { AnnotationMeta } from "./annotations";
import { findGapHiding, hasVisibleLine } from "./gaps";
import { toPierreSide, type LineSide } from "./selection";

export interface RevealTarget {
  /** File the line is in; waits until that file's diff is showing. */
  filename: string;
  side: LineSide;
  line: number;
  align: "center" | "start";
  /** Called once the line has been scrolled to. */
  onRevealed?: () => void;
}

interface UseRevealArgs {
  handleRef: RefObject<CodeViewHandle<AnnotationMeta, undefined> | null>;
  /** Pierre item id of the displayed diff. */
  itemId: string;
  filename: string;
  rows: readonly DiffRow[];
  /** Expand the collapsed gap before hunk `hunkIndex` in Pierre. */
  expandGap: (hunkIndex: number) => void;
}

/**
 * Scroll a line of the open diff into view, first expanding the collapsed
 * gap that hides it and waiting for the file's diff to be the one showing.
 * Used for keyboard focus, search matches, conversation links and gaps. Only
 * the latest request is kept.
 */
export function useReveal({
  handleRef,
  itemId,
  filename,
  rows,
  expandGap,
}: UseRevealArgs): (target: RevealTarget) => void {
  const pending = useRef<{ target: RevealTarget; expanded: boolean } | null>(
    null
  );
  const latest = useRef({ itemId, filename, rows, expandGap });
  latest.current = { itemId, filename, rows, expandGap };

  const attempt = useCallback(() => {
    const request = pending.current;
    if (!request) return;
    const { target } = request;
    const { itemId, filename, rows, expandGap } = latest.current;
    if (target.filename !== filename) return;

    if (hasVisibleLine(rows, target.side, target.line)) {
      const handle = handleRef.current;
      if (!handle) return;
      pending.current = null;
      handle.scrollTo({
        type: "line",
        id: itemId,
        lineNumber: target.line,
        side: toPierreSide(target.side),
        align: target.align,
        behavior: "instant",
      });
      target.onRevealed?.();
      return;
    }

    const gap = findGapHiding(rows, target.side, target.line);
    if (!gap) {
      // Not in this diff at all.
      pending.current = null;
      return;
    }
    if (request.expanded) return;
    request.expanded = true;
    expandGap(gap.hunkIndex);
  }, [handleRef]);

  // The diff changed (new file, hydration, expansion): try again.
  useEffect(attempt, [attempt, rows, itemId, filename]);

  return useCallback(
    (target: RevealTarget) => {
      pending.current = { target, expanded: false };
      attempt();
    },
    [attempt]
  );
}

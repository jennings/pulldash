/**
 * Patchutils-style interdiff algorithm.
 *
 * Given two unified-diff patches for the same file (old and new version of a
 * commit), computes the diff-of-diffs: what changed deliberately, with pure
 * rebase noise stripped.
 *
 * Algorithm:
 * 1. Extract the post-image line sequence (content, line number, kind) from
 *    each patch.  kind="insert" means the commit added this line; kind=
 *    "context" means it was already in the base file and is shown for context.
 * 2. Short-circuit if both post-images are byte-identical (pure rebase shift).
 * 3. LCS-align the two sequences by content using diffArrays.
 * 4. Walk the alignment:
 *    - equal pair                   → equal (regardless of kind)
 *    - v1-only AND kind="insert"    → delete
 *    - v1-only AND kind="context"   → skip (not a deliberate change)
 *    - v2-only AND kind="insert"    → insert
 *    - v2-only AND kind="context"   → skip
 * 5. Group into hunks with CONTEXT_LINES of surrounding context.
 *
 * Content-based alignment (step 3) fixes the line-number-shift bug: when v2
 * deletes a block above shared content, those shared lines move to smaller
 * line numbers but their content stays the same, so the LCS correctly groups
 * them as equal rather than emitting spurious delete+insert pairs.
 */

import gitDiffParser from "gitdiff-parser";
import { diffArrays } from "diff";
import type {
  ParsedDiff,
  DiffHunk,
  DiffSkipBlock,
  DiffLine,
  LineSegment,
} from "./diff-worker";
import { escapeHtml } from "../../shared/diff-utils";

const CONTEXT_LINES = 3;

interface PostImageEntry {
  lineNumber: number;
  content: string;
  kind: "context" | "insert";
}

/**
 * Extract post-image lines (context + inserts) from a patch, preserving their
 * line numbers and whether they were added by the commit (insert) or pre-
 * existing context (context).
 */
function buildPostImageEntries(patch: string): PostImageEntry[] {
  const entries: PostImageEntry[] = [];
  if (!patch.trim()) return entries;

  const diffContent = `diff --git a/file b/file\n--- a/file\n+++ b/file\n${patch}`;
  try {
    const files = gitDiffParser.parse(diffContent);
    if (!files[0]) return entries;

    for (const hunk of files[0].hunks) {
      for (const change of hunk.changes) {
        if (change.type === "normal") {
          entries.push({
            lineNumber: change.newLineNumber,
            content: change.content,
            kind: "context",
          });
        } else if (change.type === "insert") {
          entries.push({
            lineNumber: change.lineNumber,
            content: change.content,
            kind: "insert",
          });
        }
      }
    }
  } catch {
    // ignore parse errors
  }
  return entries;
}

/**
 * Extract the post-image lines from a unified-diff patch string.
 * Returns only the lines that survive into the new file (context + inserts).
 */
export function buildPostImageLines(patch: string): string[] {
  return buildPostImageEntries(patch).map((e) => e.content);
}

/**
 * Compute the interdiff between two versions of a commit's patch.
 *
 * @param patch1 Unified diff patch for the old version of the commit
 * @param patch2 Unified diff patch for the new version of the commit
 * @returns ParsedDiff showing deliberate changes between versions
 */
export function computeInterdiff(patch1: string, patch2: string): ParsedDiff {
  const entriesA = buildPostImageEntries(patch1);
  const entriesB = buildPostImageEntries(patch2);

  // Pure-rebase short-circuit: byte-identical post-image content (may be at
  // different line positions due to shifts above/below the changed region).
  const contentsA = entriesA.map((e) => e.content);
  const contentsB = entriesB.map((e) => e.content);
  if (contentsA.join("\n") === contentsB.join("\n")) {
    return { hunks: [] };
  }

  // LCS-align the two post-image sequences by content.
  const chunks = diffArrays(contentsA, contentsB);

  interface FlatLine {
    type: "equal" | "delete" | "insert";
    content: string;
    oldLineNumber?: number;
    newLineNumber?: number;
  }

  const flat: FlatLine[] = [];
  let idxA = 0;
  let idxB = 0;

  for (const chunk of chunks) {
    if (!chunk.added && !chunk.removed) {
      // LCS equal: same content in both post-images.
      for (const content of chunk.value) {
        const ea = entriesA[idxA++];
        const eb = entriesB[idxB++];
        flat.push({
          type: "equal",
          content,
          oldLineNumber: ea.lineNumber,
          newLineNumber: eb.lineNumber,
        });
      }
    } else if (chunk.removed) {
      // Present in v1 post-image but not v2.
      for (const content of chunk.value) {
        const ea = entriesA[idxA++];
        if (ea.kind === "insert") {
          // v1 deliberately added this line; v2 doesn't have it → delete.
          flat.push({ type: "delete", content, oldLineNumber: ea.lineNumber });
        }
        // kind="context": pre-existing line that was in v1's patch window but
        // not v2's.  Not a deliberate change → skip.
      }
    } else {
      // Present in v2 post-image but not v1.
      for (const content of chunk.value) {
        const eb = entriesB[idxB++];
        if (eb.kind === "insert") {
          // v2 deliberately added this line; v1 doesn't have it → insert.
          flat.push({ type: "insert", content, newLineNumber: eb.lineNumber });
        }
        // kind="context": pre-existing line that was in v2's patch window but
        // not v1's.  Not a deliberate change → skip.
      }
    }
  }

  const isChanged = flat.map((l) => l.type !== "equal");
  const changedIdxs = flat.map((_, i) => i).filter((i) => isChanged[i]);

  if (changedIdxs.length === 0) return { hunks: [] };

  // Merge changed indices into hunk ranges (±CONTEXT_LINES context each side)
  const ranges: [number, number][] = [];
  let rangeStart = Math.max(0, changedIdxs[0] - CONTEXT_LINES);
  let rangeEnd = Math.min(flat.length - 1, changedIdxs[0] + CONTEXT_LINES);

  for (let i = 1; i < changedIdxs.length; i++) {
    const nextStart = Math.max(0, changedIdxs[i] - CONTEXT_LINES);
    const nextEnd = Math.min(flat.length - 1, changedIdxs[i] + CONTEXT_LINES);
    if (nextStart <= rangeEnd + 1) {
      rangeEnd = Math.max(rangeEnd, nextEnd);
    } else {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = nextStart;
      rangeEnd = nextEnd;
    }
  }
  ranges.push([rangeStart, rangeEnd]);

  const output: (DiffHunk | DiffSkipBlock)[] = [];
  let prevEnd = -1;

  for (const [start, end] of ranges) {
    if (start > prevEnd + 1) {
      output.push({
        type: "skip",
        count: start - (prevEnd + 1),
        content: "",
      });
    }

    const hunkLines: DiffLine[] = [];
    for (let j = start; j <= end; j++) {
      const fl = flat[j];
      const segs: LineSegment[] = [
        { value: fl.content, html: escapeHtml(fl.content), type: "normal" },
      ];
      if (fl.type === "equal") {
        hunkLines.push({
          type: "normal",
          oldLineNumber: fl.oldLineNumber,
          newLineNumber: fl.newLineNumber,
          content: segs,
        });
      } else if (fl.type === "delete") {
        hunkLines.push({
          type: "delete",
          oldLineNumber: fl.oldLineNumber,
          content: segs,
        });
      } else {
        hunkLines.push({
          type: "insert",
          newLineNumber: fl.newLineNumber,
          content: segs,
        });
      }
    }

    const hunkStart =
      flat[start].newLineNumber ?? flat[start].oldLineNumber ?? 1;

    output.push({
      type: "hunk",
      oldStart: flat[start].oldLineNumber ?? hunkStart,
      newStart: hunkStart,
      lines: hunkLines,
    });

    prevEnd = end;
  }

  if (prevEnd < flat.length - 1) {
    output.push({
      type: "skip",
      count: flat.length - 1 - prevEnd,
      content: "",
    });
  }

  return { hunks: output };
}

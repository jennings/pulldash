/**
 * Patchutils-style interdiff algorithm.
 *
 * Given two unified-diff patches for the same file (old and new version of a
 * commit), computes the diff-of-diffs: what changed deliberately, with pure
 * rebase noise stripped.
 *
 * Algorithm:
 * 1. Reconstruct the post-image of each patch (context + insert lines).
 * 2. Diff the two post-images.
 * 3. Return the result as a ParsedDiff.
 *
 * Pure rebase shifts (same content at different line numbers) produce
 * identical post-images and therefore empty output.
 */

import gitDiffParser from "gitdiff-parser";
import { diffLines } from "diff";
import type { ParsedDiff, DiffHunk, DiffSkipBlock, DiffLine, LineSegment } from "./diff-worker";

const CONTEXT_LINES = 3;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Extract the post-image lines from a unified-diff patch string.
 * Returns only the lines that survive into the new file (context + inserts).
 */
export function buildPostImageLines(patch: string): string[] {
  if (!patch.trim()) return [];

  const diffContent = `diff --git a/file b/file\n--- a/file\n+++ b/file\n${patch}`;
  try {
    const files = gitDiffParser.parse(diffContent);
    if (!files[0]) return [];

    const lines: string[] = [];
    for (const hunk of files[0].hunks) {
      for (const change of hunk.changes) {
        if (change.type !== "delete") {
          lines.push(change.content);
        }
      }
    }
    return lines;
  } catch {
    return [];
  }
}

/**
 * Compute the interdiff between two versions of a commit's patch.
 *
 * @param patch1 Unified diff patch for the old version of the commit
 * @param patch2 Unified diff patch for the new version of the commit
 * @returns ParsedDiff showing deliberate changes between versions
 */
export function computeInterdiff(patch1: string, patch2: string): ParsedDiff {
  const linesA = buildPostImageLines(patch1);
  const linesB = buildPostImageLines(patch2);

  const diffs = diffLines(linesA.join("\n"), linesB.join("\n"));

  if (!diffs.some((d) => d.added || d.removed)) {
    return { hunks: [] };
  }

  interface FlatLine {
    type: "equal" | "delete" | "insert";
    content: string;
    oldLine: number | undefined;
    newLine: number | undefined;
  }

  const flat: FlatLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const diff of diffs) {
    const raw =
      diff.value.endsWith("\n") ? diff.value.slice(0, -1) : diff.value;
    const parts = raw.split("\n");
    for (const content of parts) {
      if (!diff.added && !diff.removed) {
        flat.push({ type: "equal", content, oldLine, newLine });
        oldLine++;
        newLine++;
      } else if (diff.removed) {
        flat.push({ type: "delete", content, oldLine, newLine: undefined });
        oldLine++;
      } else {
        flat.push({ type: "insert", content, oldLine: undefined, newLine });
        newLine++;
      }
    }
  }

  const isChanged = flat.map((l) => l.type !== "equal");
  const changedIdxs = flat
    .map((_, i) => i)
    .filter((i) => isChanged[i]);

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
          oldLineNumber: fl.oldLine,
          newLineNumber: fl.newLine,
          content: segs,
        });
      } else if (fl.type === "delete") {
        hunkLines.push({
          type: "delete",
          oldLineNumber: fl.oldLine,
          content: segs,
        });
      } else {
        hunkLines.push({
          type: "insert",
          newLineNumber: fl.newLine,
          content: segs,
        });
      }
    }

    const hunkOldStart = flat[start].oldLine ?? flat[start].newLine ?? 1;
    const hunkNewStart = flat[start].newLine ?? flat[start].oldLine ?? 1;

    output.push({
      type: "hunk",
      oldStart: hunkOldStart,
      newStart: hunkNewStart,
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

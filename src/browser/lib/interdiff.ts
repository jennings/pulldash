/**
 * Patchutils-style interdiff algorithm.
 *
 * Given two unified-diff patches for the same file (old and new version of a
 * commit), computes the diff-of-diffs: what changed deliberately, with pure
 * rebase noise stripped.
 *
 * Algorithm:
 * 1. Build a map from newLineNumber → {content, kind} for each patch.
 * 2. Short-circuit if both post-images are byte-identical (pure rebase shift).
 * 3. Walk the sorted union of newLineNumbers and classify each position.
 * 4. Return the result as a ParsedDiff.
 *
 * Pure rebase shifts (same content at different line numbers) produce
 * identical post-images and therefore empty output.
 */

import gitDiffParser from "gitdiff-parser";
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
  content: string;
  kind: "context" | "insert";
}

/**
 * Build a map from new-file line number to post-image entry.
 * Only non-delete lines (context + inserts) are included.
 */
function buildPostImageMap(patch: string): Map<number, PostImageEntry> {
  const map = new Map<number, PostImageEntry>();
  if (!patch.trim()) return map;

  const diffContent = `diff --git a/file b/file\n--- a/file\n+++ b/file\n${patch}`;
  try {
    const files = gitDiffParser.parse(diffContent);
    if (!files[0]) return map;

    for (const hunk of files[0].hunks) {
      for (const change of hunk.changes) {
        if (change.type === "normal") {
          map.set(change.newLineNumber, {
            content: change.content,
            kind: "context",
          });
        } else if (change.type === "insert") {
          map.set(change.lineNumber, {
            content: change.content,
            kind: "insert",
          });
        }
      }
    }
  } catch {
    // ignore parse errors
  }
  return map;
}

/**
 * Extract the post-image lines from a unified-diff patch string.
 * Returns only the lines that survive into the new file (context + inserts).
 */
export function buildPostImageLines(patch: string): string[] {
  const map = buildPostImageMap(patch);
  if (map.size === 0) return [];
  const keys = Array.from(map.keys()).sort((a, b) => a - b);
  return keys.map((k) => map.get(k)!.content);
}

/**
 * Compute the interdiff between two versions of a commit's patch.
 *
 * @param patch1 Unified diff patch for the old version of the commit
 * @param patch2 Unified diff patch for the new version of the commit
 * @returns ParsedDiff showing deliberate changes between versions
 */
export function computeInterdiff(patch1: string, patch2: string): ParsedDiff {
  const mapA = buildPostImageMap(patch1);
  const mapB = buildPostImageMap(patch2);

  // Pure-rebase short-circuit: byte-identical post-image content (may be at
  // different line positions due to shifts above/below the changed region).
  const linesA = buildPostImageLines(patch1);
  const linesB = buildPostImageLines(patch2);
  if (linesA.join("\n") === linesB.join("\n")) {
    return { hunks: [] };
  }

  // Walk the sorted union of all newLineNumbers from both patches.
  const allKeys = Array.from(new Set([...mapA.keys(), ...mapB.keys()])).sort(
    (a, b) => a - b
  );

  interface FlatLine {
    type: "equal" | "delete" | "insert";
    content: string;
    lineNumber: number; // the newLineNumber in v2-coordinate space
  }

  const flat: FlatLine[] = [];

  for (const n of allKeys) {
    const a = mapA.get(n);
    const b = mapB.get(n);

    if (!a && !b) continue;

    if (!a) {
      // Absent in v1, present in v2
      if (b!.kind === "context") {
        flat.push({ type: "equal", content: b!.content, lineNumber: n });
      } else {
        flat.push({ type: "insert", content: b!.content, lineNumber: n });
      }
    } else if (!b) {
      // Present in v1, absent in v2
      if (a.kind === "context") {
        flat.push({ type: "equal", content: a.content, lineNumber: n });
      } else {
        flat.push({ type: "delete", content: a.content, lineNumber: n });
      }
    } else if (a.kind === "context" && b.kind === "context") {
      // Both are context — equal if same content, modify if different
      if (a.content === b.content) {
        flat.push({ type: "equal", content: b.content, lineNumber: n });
      } else {
        flat.push({ type: "delete", content: a.content, lineNumber: n });
        flat.push({ type: "insert", content: b.content, lineNumber: n });
      }
    } else if (a.kind === "insert" && b.kind === "insert") {
      // Both are inserts
      if (a.content === b.content) {
        flat.push({ type: "equal", content: b.content, lineNumber: n });
      } else {
        flat.push({ type: "delete", content: a.content, lineNumber: n });
        flat.push({ type: "insert", content: b.content, lineNumber: n });
      }
    } else if (a.kind === "context" && b.kind === "insert") {
      // v2 inserted a line where v1 had base context
      flat.push({ type: "insert", content: b.content, lineNumber: n });
    } else {
      // a.kind === "insert" && b.kind === "context"
      // v1 inserted a line that v2 reverted to base context
      flat.push({ type: "delete", content: a.content, lineNumber: n });
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
          oldLineNumber: fl.lineNumber,
          newLineNumber: fl.lineNumber,
          content: segs,
        });
      } else if (fl.type === "delete") {
        hunkLines.push({
          type: "delete",
          oldLineNumber: fl.lineNumber,
          content: segs,
        });
      } else {
        hunkLines.push({
          type: "insert",
          newLineNumber: fl.lineNumber,
          content: segs,
        });
      }
    }

    const hunkStart = flat[start].lineNumber;

    output.push({
      type: "hunk",
      oldStart: hunkStart,
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

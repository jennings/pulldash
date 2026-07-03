/**
 * Patchutils-style interdiff algorithm.
 *
 * Given two unified-diff patches for the same file (old and new version of a
 * commit), computes the diff-of-diffs: what changed deliberately, with pure
 * rebase noise stripped.
 *
 * Algorithm:
 * 1. Extract every line from each patch (context, insert, delete) preserving
 *    its kind and the line number it carries.
 * 2. Short-circuit if both patches' kind-tagged sequences are byte-identical.
 * 3. LCS-align the two sequences by content using diffArrays.
 * 4. Walk the alignment.  For each chunk, classify per (side, kind):
 *      B-only insert  → INSERT (v2 added a line v1 didn't)
 *      B-only delete  → DELETE (v2 removed a line v1 didn't touch)
 *      A-only insert  → DELETE (v1 added a line v2 doesn't have)
 *      A-only delete  → INSERT (v1 removed a line v2 still has)
 *      *-only context → skip (rebase noise — patch window only)
 *      equal pair, same kind          → equal
 *      equal pair, insertA/deleteB    → DELETE (v1 added it; v2 removed it)
 *      equal pair, deleteA/insertB    → INSERT (v1 removed it; v2 re-added it)
 *      equal pair, both delete        → skip
 *      equal pair, both insert        → equal (rebase noise)
 *      equal pair, contextA/deleteB   → DELETE (v2 removed it)
 *      equal pair, deleteA/contextB   → INSERT (v2 kept it)
 *      equal pair, other kind mismatch→ equal (LCS misalignment)
 * 5. Group into hunks with CONTEXT_LINES of surrounding context.
 *
 * Content-based alignment (step 3) handles the line-number-shift case: when v2
 * deletes a block above shared content, those shared lines move to smaller
 * line numbers but their content stays the same, so the LCS correctly groups
 * them as equal rather than emitting spurious delete+insert pairs.
 *
 * Including delete lines (vs. the older post-image-only model) handles the
 * case where v2's patch contains -X/+Y in a region v1's patch doesn't touch:
 * the older algorithm could only see +Y and emitted a lone insert.  Now -X is
 * preserved through the alignment and emitted as a DELETE.
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
import { escapeHtml, highlightFileByLines } from "../../shared/diff-utils";

const extToLang: Record<string, string> = {
  py: "python",
  js: "javascript",
  ts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  c: "c",
  cpp: "cpp",
  cs: "csharp",
  sh: "bash",
  bash: "bash",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  md: "markdown",
  css: "css",
  html: "markup",
  xml: "markup",
};

function guessLang(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return extToLang[ext] ?? "tsx";
}

const CONTEXT_LINES = 3;

interface PatchLineEntry {
  content: string;
  kind: "context" | "insert" | "delete";
  // context: both line numbers populated
  // insert : only newLineNumber
  // delete : only oldLineNumber
  oldLineNumber?: number;
  newLineNumber?: number;
}

/**
 * Extract every line from a patch (context, insert, delete), preserving each
 * line's kind and the line numbers gitdiff-parser exposes for it.
 */
function buildPatchEntries(patch: string): PatchLineEntry[] {
  const entries: PatchLineEntry[] = [];
  if (!patch.trim()) return entries;

  const diffContent = `diff --git a/file b/file\n--- a/file\n+++ b/file\n${patch}`;
  try {
    const files = gitDiffParser.parse(diffContent);
    if (!files[0]) return entries;

    for (const hunk of files[0].hunks) {
      for (const change of hunk.changes) {
        if (change.type === "normal") {
          entries.push({
            content: change.content,
            kind: "context",
            oldLineNumber: change.oldLineNumber,
            newLineNumber: change.newLineNumber,
          });
        } else if (change.type === "insert") {
          entries.push({
            content: change.content,
            kind: "insert",
            newLineNumber: change.lineNumber,
          });
        } else if (change.type === "delete") {
          entries.push({
            content: change.content,
            kind: "delete",
            oldLineNumber: change.lineNumber,
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
  return buildPatchEntries(patch)
    .filter((e) => e.kind !== "delete")
    .map((e) => e.content);
}

/**
 * Compute the interdiff between two versions of a commit's patch.
 *
 * @param patch1 Unified diff patch for the old version of the commit
 * @param patch2 Unified diff patch for the new version of the commit
 * @returns ParsedDiff showing deliberate changes between versions
 */
export function computeInterdiff(
  patch1: string,
  patch2: string,
  filename?: string
): ParsedDiff {
  const entriesA = buildPatchEntries(patch1);
  const entriesB = buildPatchEntries(patch2);

  // Pure-rebase short-circuit: identical kind-tagged sequences mean both
  // patches do the same thing (possibly at different line positions).
  // Comparing content alone would falsely match a +X patch against a -X patch.
  const sigA = entriesA.map((e) => `${e.kind[0]}:${e.content}`).join("\n");
  const sigB = entriesB.map((e) => `${e.kind[0]}:${e.content}`).join("\n");
  if (sigA === sigB) {
    return { hunks: [] };
  }

  // LCS-align the two entry sequences by content.
  const contentsA = entriesA.map((e) => e.content);
  const contentsB = entriesB.map((e) => e.content);
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

  // Track the expected next old/new post-image line numbers as we walk the
  // aligned sequences. A-only / B-only context lines (present in one patch's
  // window but not the other's) don't carry the missing side's real number,
  // so we synthesize it from this counter to keep the sequence monotonic and
  // consistent with surrounding paired equals. 0 means "no anchor yet"; fall
  // back to the visible side's number in that case.
  let nextOld = 0;
  let nextNew = 0;

  const pushFlat = (line: FlatLine) => {
    flat.push(line);
    if (line.oldLineNumber != null) nextOld = line.oldLineNumber + 1;
    if (line.newLineNumber != null) nextNew = line.newLineNumber + 1;
  };

  for (const chunk of chunks) {
    if (!chunk.added && !chunk.removed) {
      // LCS equal: same content in both sequences.  Disambiguate by kind.
      for (const content of chunk.value) {
        const ea = entriesA[idxA++];
        const eb = entriesB[idxB++];
        if (ea.kind === "insert" && eb.kind === "delete") {
          // v1 added it; v2 removed it.  Net: line is gone in v2.
          pushFlat({
            type: "delete",
            content,
            oldLineNumber: ea.newLineNumber,
          });
        } else if (ea.kind === "delete" && eb.kind === "insert") {
          // v1 removed it; v2 re-added it.  Net: line is present in v2 only.
          pushFlat({
            type: "insert",
            content,
            newLineNumber: eb.newLineNumber,
          });
        } else if (ea.kind === "delete" && eb.kind === "delete") {
          // Both versions remove the same line — equal, but not part of either
          // post-image, so skip rather than emitting a context line.
        } else if (ea.kind === "insert" && eb.kind === "insert") {
          // Both patches add the same line — equal, rebase noise.
          pushFlat({
            type: "equal",
            content,
            oldLineNumber: ea.newLineNumber,
            newLineNumber: eb.newLineNumber,
          });
        } else if (ea.kind === "context" && eb.kind === "delete") {
          // v1 kept it as context; v2 deleted it → DELETE.
          pushFlat({
            type: "delete",
            content,
            oldLineNumber: eb.oldLineNumber,
          });
        } else if (ea.kind === "delete" && eb.kind === "context") {
          // v1 deleted it; v2 kept it as context → INSERT.
          pushFlat({
            type: "insert",
            content,
            newLineNumber: eb.newLineNumber,
          });
        } else {
          // Other pairs (context/insert, insert/context) are typically LCS
          // misalignment — same content matched from different file positions.
          // Emit as equal to avoid spurious changes.
          pushFlat({
            type: "equal",
            content,
            oldLineNumber: ea.newLineNumber ?? ea.oldLineNumber,
            newLineNumber: eb.newLineNumber ?? eb.oldLineNumber,
          });
        }
      }
    } else if (chunk.removed) {
      // Present in v1's patch sequence but not v2's.
      for (const content of chunk.value) {
        const ea = entriesA[idxA++];
        if (ea.kind === "insert") {
          // v1 deliberately added this line; v2 doesn't have it → delete.
          pushFlat({
            type: "delete",
            content,
            oldLineNumber: ea.newLineNumber,
          });
        } else if (ea.kind === "delete") {
          // v1 removed this line; v2's patch doesn't touch it (so v2 still has
          // it) → present in v2 but absent in v1 → insert.
          pushFlat({
            type: "insert",
            content,
            newLineNumber: ea.oldLineNumber,
          });
        } else {
          // kind="context": line is in v1's patch window but not v2's.
          // Treat as equal (both versions have it, but v2 just doesn't include
          // it in its patch window). Old-side gets v1's real number; new-side
          // is synthesized from the running counter so it stays consistent
          // with surrounding paired equals.
          const oldLineNumber = ea.newLineNumber;
          const newLineNumber = nextNew || oldLineNumber;
          pushFlat({
            type: "equal",
            content,
            oldLineNumber,
            newLineNumber,
          });
        }
      }
    } else {
      // Present in v2's patch sequence but not v1's.
      for (const content of chunk.value) {
        const eb = entriesB[idxB++];
        if (eb.kind === "insert") {
          // v2 deliberately added this line; v1 doesn't have it → insert.
          pushFlat({
            type: "insert",
            content,
            newLineNumber: eb.newLineNumber,
          });
        } else if (eb.kind === "delete") {
          // v2 removed this line; v1's patch doesn't touch it (so v1 still had
          // it) → present in v1 but absent in v2 → delete.
          pushFlat({
            type: "delete",
            content,
            oldLineNumber: eb.oldLineNumber,
          });
        } else {
          // kind="context": mirror of the A-only branch. New-side gets v2's
          // real number; old-side is synthesized from the running counter.
          const newLineNumber = eb.newLineNumber;
          const oldLineNumber = nextOld || newLineNumber;
          pushFlat({
            type: "equal",
            content,
            oldLineNumber,
            newLineNumber,
          });
        }
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
  // Track the next post-image (newLineNumber) file line the diff should cover.
  // Skip-block counts are expressed as gaps in real file line numbers so that
  // expansion fetches the correct range from the head file; using indices into
  // `flat` (which only contains lines the two patches touched) undercounts by
  // orders of magnitude.
  let nextFileLine = 1;

  for (const [start, end] of ranges) {
    const hunkBlock = flat.slice(start, end + 1);

    // Determine this hunk's first and last post-image line numbers. Hunks
    // include CONTEXT_LINES of equal context on each side, so newLineNumber is
    // almost always populated on the edge entries; fall back defensively.
    let firstNewLine: number | undefined;
    let lastNewLine: number | undefined;
    for (const fl of hunkBlock) {
      if (fl.newLineNumber != null) {
        if (firstNewLine === undefined) firstNewLine = fl.newLineNumber;
        lastNewLine = fl.newLineNumber;
      }
    }
    const hunkStart = firstNewLine ?? flat[start].oldLineNumber ?? nextFileLine;
    const hunkEnd = lastNewLine ?? hunkStart;

    if (hunkStart > nextFileLine) {
      output.push({
        type: "skip",
        count: hunkStart - nextFileLine,
        content: "",
      });
    }

    const hunkLines: DiffLine[] = [];
    const lang = filename ? guessLang(filename) : null;
    const hunkHtml = lang
      ? highlightFileByLines(hunkBlock.map((fl) => fl.content).join("\n"), lang)
      : hunkBlock.map((fl) => escapeHtml(fl.content));
    hunkBlock.forEach((fl, idx) => {
      const segs: LineSegment[] = [
        {
          value: fl.content,
          html: hunkHtml[idx] ?? escapeHtml(fl.content),
          type: "normal",
        },
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
    });

    output.push({
      type: "hunk",
      oldStart: flat[start].oldLineNumber ?? hunkStart,
      newStart: hunkStart,
      lines: hunkLines,
    });

    nextFileLine = hunkEnd + 1;
  }

  // Trailing skip: total file length is not known here (the worker only sees
  // the two patches). Emit a sentinel count that the expansion handler clamps
  // to the fetched file's actual length. `content` provides the user-visible
  // label since the count is not meaningful on its own.
  output.push({
    type: "skip",
    count: Number.MAX_SAFE_INTEGER,
    content: "Show remainder of file",
  });

  return { hunks: output };
}

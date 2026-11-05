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
 * 3. LCS-align by content and base position, using shared unique lines to
 *    account for rebases without matching unrelated repeated context.
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
 * 5. Group into hunks with CONTEXT_LINES of surrounding context, stopping at
 *    gaps between sparse patch windows, and print them as unified hunks whose
 *    old side numbers the first patch's post-image and whose new side numbers
 *    the second's.
 *
 * Base-position alignment (step 3) handles the line-number-shift case: when v2
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

const CONTEXT_LINES = 3;

interface PatchLineEntry {
  content: string;
  kind: "context" | "insert" | "delete";
  baseLineNumber: number;
  offsetAfter: number;
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
      let oldLine = Math.max(1, hunk.oldStart);
      let newLine = Math.max(1, hunk.newStart);
      for (const change of hunk.changes) {
        const baseLineNumber = oldLine;
        if (change.type !== "insert") oldLine++;
        if (change.type !== "delete") newLine++;
        const position = { baseLineNumber, offsetAfter: newLine - oldLine };
        if (change.type === "normal") {
          entries.push({
            ...position,
            content: change.content,
            kind: "context",
            oldLineNumber: change.oldLineNumber,
            newLineNumber: change.newLineNumber,
          });
        } else if (change.type === "insert") {
          entries.push({
            ...position,
            content: change.content,
            kind: "insert",
            newLineNumber: change.lineNumber,
          });
        } else if (change.type === "delete") {
          entries.push({
            ...position,
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

function postImageLine(entries: PatchLineEntry[], baseLine: number) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (entries[mid].baseLineNumber <= baseLine) low = mid + 1;
    else high = mid;
  }
  return baseLine + (entries[low - 1]?.offsetAfter ?? 0);
}

function baseLineMapper(from: PatchLineEntry[], to: PatchLineEntry[]) {
  const unique = (entries: PatchLineEntry[]) => {
    const map = new Map<string, PatchLineEntry | null>();
    for (const entry of entries) {
      if (entry.content.trim())
        map.set(entry.content, map.has(entry.content) ? null : entry);
    }
    return map;
  };
  const target = unique(to);
  const anchors: { line: number; offset: number }[] = [];
  for (const entry of unique(from).values()) {
    const match = entry && target.get(entry.content);
    if (entry && match && entry.kind === match.kind)
      anchors.push({
        line: entry.baseLineNumber,
        offset: match.baseLineNumber - entry.baseLineNumber,
      });
  }
  anchors.sort((a, b) => a.line - b.line);
  return (line: number) => {
    let low = 0;
    let high = anchors.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (anchors[mid].line < line) low = mid + 1;
      else high = mid;
    }
    const before = anchors[low - 1];
    const after = anchors[low];
    const best =
      !before || (after && after.line - line < line - before.line)
        ? after
        : before;
    return line + (best?.offset ?? 0);
  };
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

function orderChangeGroups<T extends { type: string }>(lines: T[]) {
  for (let start = 0; start < lines.length; ) {
    if (lines[start].type !== "delete" && lines[start].type !== "insert") {
      start++;
      continue;
    }
    let end = start;
    while (
      end < lines.length &&
      (lines[end].type === "delete" || lines[end].type === "insert")
    )
      end++;
    const block = lines.slice(start, end);
    lines.splice(
      start,
      block.length,
      ...block.filter((line) => line.type === "delete"),
      ...block.filter((line) => line.type === "insert")
    );
    start = end;
  }
}

/**
 * Compute the interdiff between two versions of a commit's patch.
 *
 * @param patch1 Unified diff patch for the old version of the commit
 * @param patch2 Unified diff patch for the new version of the commit
 * @returns Hunk-only unified patch (starting at `@@`) of the deliberate
 *   changes between the versions; empty when there are none. Line numbers are
 *   real file coordinates: old = version 1's file, new = version 2's file.
 */
export function computeInterdiff(patch1: string, patch2: string): string {
  const entriesA = buildPatchEntries(patch1);
  const entriesB = buildPatchEntries(patch2);

  // Pure-rebase short-circuit: identical kind-tagged sequences mean both
  // patches do the same thing (possibly at different line positions).
  // Comparing content alone would falsely match a +X patch against a -X patch.
  const sigA = entriesA.map((e) => `${e.kind[0]}:${e.content}`).join("\n");
  const sigB = entriesB.map((e) => `${e.kind[0]}:${e.content}`).join("\n");
  if (sigA === sigB) return "";

  const baseAtoB = baseLineMapper(entriesA, entriesB);
  const baseBtoA = baseLineMapper(entriesB, entriesA);
  // Repeated context such as blank lines must not align unrelated patch windows.
  const chunks = diffArrays(entriesA, entriesB, {
    comparator: (a, b) =>
      a.content === b.content &&
      baseAtoB(a.baseLineNumber) === b.baseLineNumber,
  });

  interface FlatLine {
    type: "equal" | "delete" | "insert";
    content: string;
    oldLineNumber?: number;
    newLineNumber?: number;
  }

  const flat: FlatLine[] = [];
  let idxA = 0;
  let idxB = 0;

  const pushFlat = (line: FlatLine) => {
    flat.push(line);
  };

  for (const chunk of chunks) {
    if (!chunk.added && !chunk.removed) {
      // LCS equal: same content in both sequences.  Disambiguate by kind.
      for (const { content } of chunk.value) {
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
            oldLineNumber: ea.newLineNumber,
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
      for (const { content } of chunk.value) {
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
            newLineNumber: postImageLine(entriesB, baseAtoB(ea.baseLineNumber)),
          });
        } else {
          // Context outside the other patch's windows still has real file coordinates.
          const oldLineNumber = ea.newLineNumber;
          const newLineNumber = postImageLine(
            entriesB,
            baseAtoB(ea.baseLineNumber)
          );
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
      for (const { content } of chunk.value) {
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
            oldLineNumber: postImageLine(entriesA, baseBtoA(eb.baseLineNumber)),
          });
        } else {
          const newLineNumber = eb.newLineNumber;
          const oldLineNumber = postImageLine(
            entriesA,
            baseBtoA(eb.baseLineNumber)
          );
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

  // Patch windows omit real file lines. Context expansion and replacement
  // pairing must stop at those gaps rather than treating the windows as adjacent.
  const regions: [number, number][] = [];
  let regionStart = 0;
  let lastOld: number | undefined;
  let lastNew: number | undefined;
  flat.forEach((line, index) => {
    if (
      (line.oldLineNumber != null &&
        lastOld != null &&
        line.oldLineNumber !== lastOld + 1) ||
      (line.newLineNumber != null &&
        lastNew != null &&
        line.newLineNumber !== lastNew + 1)
    ) {
      regions.push([regionStart, index]);
      regionStart = index;
      lastOld = lastNew = undefined;
    }
    if (line.oldLineNumber != null) lastOld = line.oldLineNumber;
    if (line.newLineNumber != null) lastNew = line.newLineNumber;
  });
  regions.push([regionStart, flat.length]);

  const ranges: [number, number][] = [];
  for (const [start, end] of regions) {
    const block = flat.slice(start, end);
    orderChangeGroups(block);
    flat.splice(start, block.length, ...block);
    let range: [number, number] | undefined;
    for (let index = start; index < end; index++) {
      if (flat[index].type === "equal") continue;
      const nextStart = Math.max(start, index - CONTEXT_LINES);
      const nextEnd = Math.min(end - 1, index + CONTEXT_LINES);
      if (range && nextStart <= range[1] + 1) range[1] = nextEnd;
      else {
        range = [nextStart, nextEnd];
        ranges.push(range);
      }
    }
  }
  if (!ranges.length) return "";

  const hunks: string[] = [];
  // The next old/new file line after the previous hunk: where a hunk without
  // lines of its own on one side (a pure insertion) is anchored.
  let nextNewLine = 1;
  let nextOldLine = 1;

  for (const [start, end] of ranges) {
    const block = flat.slice(start, end + 1);
    const oldLines = block.filter((line) => line.type !== "insert");
    const newLines = block.filter((line) => line.type !== "delete");
    const firstOld = oldLines.find(
      (line) => line.oldLineNumber != null
    )?.oldLineNumber;
    const firstNew = newLines.find(
      (line) => line.newLineNumber != null
    )?.newLineNumber;
    const oldStart = firstOld ?? nextOldLine;
    const newStart = firstNew ?? nextNewLine;
    // Git numbers an empty side by the line before it.
    const oldHeader = oldLines.length === 0 ? oldStart - 1 : oldStart;
    const newHeader = newLines.length === 0 ? newStart - 1 : newStart;

    hunks.push(
      [
        `@@ -${oldHeader},${oldLines.length} +${newHeader},${newLines.length} @@`,
        ...block.map(
          (line) =>
            `${line.type === "equal" ? " " : line.type === "delete" ? "-" : "+"}${line.content}`
        ),
      ].join("\n")
    );

    const lastNew = block.findLast(
      (line) => line.newLineNumber != null
    )?.newLineNumber;
    const lastOld = block.findLast(
      (line) => line.oldLineNumber != null
    )?.oldLineNumber;
    nextNewLine = (lastNew ?? nextNewLine - 1) + 1;
    nextOldLine = (lastOld ?? nextOldLine - 1) + 1;
  }

  return hunks.join("\n");
}

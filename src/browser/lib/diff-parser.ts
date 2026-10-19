/**
 * Diff parsing, inline change merging, and syntax highlighting.
 */

import gitDiffParser, {
  Hunk as _Hunk,
  Change as _Change,
  DeleteChange,
  InsertChange,
} from "gitdiff-parser";
import { diffArrays } from "diff";
import { refractor } from "refractor/all";
import { INLINE_MAX_CHAR_EDITS } from "../../diff-parse-constants";
import {
  buildInlineDiffSegments,
  escapeHtml,
  hastToHtml,
  highlightFileByLines,
  tokenizeWords,
  type RawLineSegment,
} from "../../shared/diff-utils";

// ============================================================================
// Types
// ============================================================================

export interface LineSegment {
  value: string;
  html: string;
  type: "insert" | "delete" | "normal";
}

export interface DiffLine {
  type: "insert" | "delete" | "normal";
  lineNumber?: number;
  oldLineNumber?: number;
  newLineNumber?: number;
  content: LineSegment[];
}

export interface DiffHunk {
  type: "hunk";
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
  /** True when this hunk is a rebase artifact (identical in both patch versions) */
  isRebaseArtifact?: boolean;
}

export interface DiffSkipBlock {
  type: "skip";
  count: number;
  content: string;
}

export interface ParsedDiff {
  hunks: (DiffHunk | DiffSkipBlock)[];
}

interface ParseOptions {
  maxDiffDistance: number;
  maxChangeRatio: number;
  mergeModifiedLines: boolean;
  inlineMaxCharEdits: number;
}

type ReplaceKey<T, K extends PropertyKey, V> = T extends unknown
  ? Omit<T, K> & Record<K, V>
  : never;

type Line = ReplaceKey<_Change, "content", RawLineSegment[]> & {
  oldLineNumber?: number;
  newLineNumber?: number;
};

interface Hunk extends Omit<_Hunk, "changes"> {
  type: "hunk";
  lines: Line[];
}

interface SkipBlock {
  count: number;
  type: "skip";
  content: string;
}

// ============================================================================
// Message Types
// ============================================================================

export type WorkerRequest =
  | {
      type: "parse-diff";
      id: string;
      patch: string;
      filename: string;
      previousFilename?: string;
      /** Full content of the old (base) version of the file for proper highlighting */
      oldContent?: string;
      /** Full content of the new (head) version of the file for proper highlighting */
      newContent?: string;
    }
  | {
      type: "highlight-lines";
      id: string;
      content: string;
      filename: string;
      startLine: number;
      // Old-side line number that pairs with `startLine`. Expansion reveals
      // equal (context) lines, so oldLine and newLine advance in lockstep from
      // here. Callers that only care about post-image numbering can pass the
      // same value as `startLine`.
      oldStartLine: number;
      count: number;
    }
  | {
      type: "interdiff";
      id: string;
      patch1: string;
      patch2: string;
      filename?: string;
    };

export type WorkerResponse =
  | {
      type: "parse-diff-result";
      id: string;
      result: ParsedDiff;
    }
  | {
      type: "highlight-lines-result";
      id: string;
      result: DiffLine[];
    }
  | {
      type: "interdiff-result";
      id: string;
      result: ParsedDiff;
    }
  | {
      type: "error";
      id: string;
      error: string;
    };

// ============================================================================
// Language Detection
// ============================================================================

import { guessLang } from "../../shared/language";

// ============================================================================
// Syntax Highlighting
// ============================================================================

function highlight(code: string, lang: string): string {
  try {
    const tree = refractor.highlight(code, lang);
    return tree.children.map(hastToHtml).join("");
  } catch {
    return escapeHtml(code);
  }
}

// ============================================================================
// Diff Parsing
// ============================================================================

const calculateChangeRatio = (a: string, b: string): number => {
  const totalChars = a.length + b.length;
  if (totalChars === 0) return 1;
  const tokensA = tokenizeWords(a);
  const tokensB = tokenizeWords(b);
  const diffs = diffArrays(tokensA, tokensB);
  const changedChars = diffs
    .filter((part) => part.added || part.removed)
    .reduce((sum, part) => sum + part.value.join("").length, 0);
  return changedChars / totalChars;
};

const changeToLine = (change: _Change): Line => {
  const line: Line = {
    ...change,
    content: [{ value: change.content, type: "normal" }],
  };
  if ("lineNumber" in change && change.lineNumber != null) {
    if (change.type === "insert") {
      (line as any).newLineNumber = change.lineNumber;
    } else {
      (line as any).oldLineNumber = change.lineNumber;
    }
  }
  return line;
};

const UNPAIRED = -1;

function buildChangeIndices(changes: _Change[]) {
  const insertIdxs: number[] = [];
  const deleteIdxs: number[] = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (c.type === "insert") insertIdxs.push(i);
    else if (c.type === "delete") deleteIdxs.push(i);
  }
  return { insertIdxs, deleteIdxs };
}

// A delete and an insert separated by a context (normal) line belong to
// different change groups in the diff: git treats them as independent edits.
// Merging them across the context line mispositions the merged row and makes
// one of the gutter columns non-monotonic, so such pairs are never formed.
function hasContextBetween(changes: _Change[], delIdx: number, addIdx: number) {
  for (let i = delIdx + 1; i < addIdx; i++) {
    if (changes[i].type === "normal") return true;
  }
  return false;
}

function findBestInsertForDelete(
  changes: _Change[],
  delIdx: number,
  insertIdxs: number[],
  pairOfAdd: Int32Array,
  options: ParseOptions
): number {
  const del = changes[delIdx] as DeleteChange;

  let bestAddIdx = UNPAIRED;
  let bestRatio = Infinity;
  let bestDist = Infinity;

  for (const addIdx of insertIdxs) {
    const add = changes[addIdx] as InsertChange;
    if (pairOfAdd[addIdx] !== UNPAIRED) continue;
    if (addIdx < delIdx) continue;
    if (hasContextBetween(changes, delIdx, addIdx)) continue;

    const ratio = calculateChangeRatio(del.content, add.content);
    if (ratio > options.maxChangeRatio) continue;
    const dist = addIdx - delIdx;
    if (ratio < bestRatio - 0.05) {
      bestRatio = ratio;
      bestAddIdx = addIdx;
      bestDist = dist;
    } else if (Math.abs(ratio - bestRatio) <= 0.05) {
      if (dist < bestDist) {
        bestAddIdx = addIdx;
        bestRatio = ratio;
        bestDist = dist;
      }
    }
  }

  return bestAddIdx;
}

function buildInitialPairs(
  changes: _Change[],
  insertIdxs: number[],
  deleteIdxs: number[],
  options: ParseOptions
) {
  const n = changes.length;
  const pairOfDel = new Int32Array(n).fill(UNPAIRED);
  const pairOfAdd = new Int32Array(n).fill(UNPAIRED);

  for (const di of deleteIdxs) {
    const bestAddIdx = findBestInsertForDelete(
      changes,
      di,
      insertIdxs,
      pairOfAdd,
      options
    );
    if (bestAddIdx !== UNPAIRED) {
      pairOfDel[di] = bestAddIdx;
      pairOfAdd[bestAddIdx] = di;
    }
  }

  return { pairOfDel, pairOfAdd };
}

function detectAndUnpairCrossings(
  changes: _Change[],
  pairOfDel: Int32Array,
  pairOfAdd: Int32Array,
  deleteIdxs: number[]
) {
  const pairs: { delIdx: number; oldLN: number; newLN: number }[] = [];
  for (const di of deleteIdxs) {
    const ai = pairOfDel[di];
    if (ai === UNPAIRED) continue;
    const del = changes[di] as DeleteChange;
    const add = changes[ai] as InsertChange;
    pairs.push({ delIdx: di, oldLN: del.lineNumber, newLN: add.lineNumber });
  }

  pairs.sort((a, b) => a.newLN - b.newLN);

  for (let i = 1; i < pairs.length; i++) {
    if (pairs[i].oldLN < pairs[i - 1].oldLN) {
      const d1 = Math.abs(pairs[i - 1].oldLN - pairs[i - 1].newLN);
      const d2 = Math.abs(pairs[i].oldLN - pairs[i].newLN);
      if (d1 >= d2) {
        const di = pairs[i - 1].delIdx;
        const ai = pairOfDel[di];
        pairOfDel[di] = UNPAIRED;
        pairOfAdd[ai] = UNPAIRED;
      } else {
        const di = pairs[i].delIdx;
        const ai = pairOfDel[di];
        pairOfDel[di] = UNPAIRED;
        pairOfAdd[ai] = UNPAIRED;
      }
      return detectAndUnpairCrossings(
        changes,
        pairOfDel,
        pairOfAdd,
        deleteIdxs
      );
    }
  }
}

// Rows are ordered by their position in the NEW file so the new-side gutter
// always reads monotonically: context, insert and merged rows are keyed by
// their new line number. Unpaired deletes (which have no new line number) are
// keyed just past the nearest row that has a new line number and precedes them
// in the OLD file, so both gutters stay monotonic; when no such row exists
// (delete before the hunk's first new-side line) the hunk's old→new delta is
// used as a fallback. The sort is stable, so rows that share a key keep their
// original diff order (deletes before inserts within a change group).
function computeSortKeys(rows: Line[], delta: number) {
  const newSide: { old: number; new: number }[] = [];
  for (const line of rows) {
    const n = (line as any).newLineNumber;
    const o = (line as any).oldLineNumber;
    if (n != null && o != null) newSide.push({ old: o, new: n });
  }
  newSide.sort((a, b) => a.old - b.old);

  for (const line of rows) {
    const n = (line as any).newLineNumber;
    if (n != null) {
      (line as any)._sortKey = n;
      continue;
    }
    const old = (line as any).oldLineNumber ?? (line as any).lineNumber ?? 0;
    let key: number | null = null;
    for (let i = newSide.length - 1; i >= 0; i--) {
      if (newSide[i].old <= old) {
        key = newSide[i].new + 0.5;
        break;
      }
    }
    (line as any)._sortKey = key ?? old + delta;
  }
}

function emitNormal(out: Line[], c: _Change) {
  out.push(changeToLine(c));
}

function emitModified(
  out: Line[],
  del: DeleteChange,
  add: InsertChange,
  options: ParseOptions
) {
  out.push({
    oldLineNumber: del.lineNumber,
    newLineNumber: add.lineNumber,
    type: "normal",
    isNormal: true,
    content: buildInlineDiffSegments(
      del.content,
      add.content,
      options.inlineMaxCharEdits
    ),
  });
}

function emitLines(
  changes: _Change[],
  pairOfDel: Int32Array,
  pairOfAdd: Int32Array,
  options: ParseOptions,
  delta: number
): Line[] {
  const out: Line[] = [];
  const unpairedInserts: Line[] = [];
  const processed = new Uint8Array(changes.length);

  for (let i = 0; i < changes.length; i++) {
    if (processed[i]) continue;
    const c = changes[i];

    if (c.type === "normal") {
      processed[i] = 1;
      emitNormal(out, c);
    } else if (c.type === "delete") {
      const pairedAddIdx = pairOfDel[i];
      if (pairedAddIdx === UNPAIRED) {
        processed[i] = 1;
        emitNormal(out, c);
      } else {
        const add = changes[pairedAddIdx] as InsertChange;
        emitModified(out, c, add, options);
        processed[i] = 1;
        processed[pairedAddIdx] = 1;
      }
    } else {
      const pairedDelIdx = pairOfAdd[i];
      if (pairedDelIdx === UNPAIRED) {
        processed[i] = 1;
        unpairedInserts.push(changeToLine(c));
      } else {
        const del = changes[pairedDelIdx] as DeleteChange;
        emitModified(out, del, c, options);
        processed[i] = 1;
        processed[pairedDelIdx] = 1;
      }
    }
  }

  const result = [...out, ...unpairedInserts];
  computeSortKeys(result, delta);
  result.sort((a, b) => {
    const aKey = (a as any)._sortKey ?? -Infinity;
    const bKey = (b as any)._sortKey ?? -Infinity;
    return aKey - bKey;
  });

  for (let i = 0; i < result.length - 1; i++) {
    const a = result[i];
    const b = result[i + 1];
    let del: Line, ins: Line;
    if (a.type === "delete" && b.type === "insert") {
      del = a;
      ins = b;
    } else if (a.type === "insert" && b.type === "delete") {
      ins = a;
      del = b;
    } else continue;
    if (
      del.content.length === 1 &&
      ins.content.length === 1 &&
      del.content[0].value.trim() === "" &&
      ins.content[0].value.trim() === ""
    ) {
      result[i] = {
        type: "normal",
        isNormal: true,
        oldLineNumber: (del as any).lineNumber ?? (del as any).oldLineNumber,
        newLineNumber: (ins as any).lineNumber ?? (ins as any).newLineNumber,
        content: ins.content,
      } as Line;
      result.splice(i + 1, 1);
      i--;
    }
  }

  return result;
}

export function mergeModifiedLines(
  changes: _Change[],
  options: ParseOptions = defaultOptions,
  delta = 0
): Line[] {
  const { insertIdxs, deleteIdxs } = buildChangeIndices(changes);
  const { pairOfDel, pairOfAdd } = buildInitialPairs(
    changes,
    insertIdxs,
    deleteIdxs,
    options
  );
  detectAndUnpairCrossings(changes, pairOfDel, pairOfAdd, deleteIdxs);

  // Count unpaired deletes and inserts to detect complete permutations
  // (e.g. rotation of identical lines) where crossings are expected.
  let unpairedDelCount = 0;
  for (const di of deleteIdxs) {
    if (pairOfDel[di] === UNPAIRED) unpairedDelCount++;
  }
  let unpairedInsCount = 0;
  for (const ai of insertIdxs) {
    if (pairOfAdd[ai] === UNPAIRED) unpairedInsCount++;
  }
  const isCompletePermutation =
    unpairedDelCount > 0 && unpairedDelCount === unpairedInsCount;

  for (const di of deleteIdxs) {
    if (pairOfDel[di] !== UNPAIRED) continue;
    const del = changes[di] as DeleteChange;
    for (const ai of insertIdxs) {
      if (pairOfAdd[ai] !== UNPAIRED) continue;
      if (ai < di) continue;
      if (hasContextBetween(changes, di, ai)) continue;
      const add = changes[ai] as InsertChange;
      if (del.content.trim() !== add.content.trim()) continue;
      if (del.content.trim() === "") continue;

      // Prevent re-pairing that would create non-monotonic crossings,
      // unless this is a complete permutation (rotation) of identical lines.
      if (
        !isCompletePermutation &&
        wouldCreateCrossing(changes, pairOfDel, pairOfAdd, deleteIdxs, di, ai)
      ) {
        continue;
      }

      pairOfDel[di] = ai;
      pairOfAdd[ai] = di;
      break;
    }
  }

  return emitLines(changes, pairOfDel, pairOfAdd, options, delta);
}

function wouldCreateCrossing(
  changes: _Change[],
  pairOfDel: Int32Array,
  pairOfAdd: Int32Array,
  deleteIdxs: number[],
  candidateDelIdx: number,
  candidateAddIdx: number
): boolean {
  const del = changes[candidateDelIdx] as DeleteChange;
  const add = changes[candidateAddIdx] as InsertChange;
  const candOld = del.lineNumber;
  const candNew = add.lineNumber;

  for (const di of deleteIdxs) {
    if (di === candidateDelIdx) continue;
    const ai = pairOfDel[di];
    if (ai === UNPAIRED) continue;
    const d = changes[di] as DeleteChange;
    const a = changes[ai] as InsertChange;
    const otherOld = d.lineNumber;
    const otherNew = a.lineNumber;

    if (
      (candOld < otherOld && candNew > otherNew) ||
      (candOld > otherOld && candNew < otherNew)
    ) {
      return true;
    }
  }
  return false;
}

const parseHunk = (hunk: _Hunk, options: ParseOptions): Hunk => {
  return {
    ...hunk,
    type: "hunk",
    lines: options.mergeModifiedLines
      ? mergeModifiedLines(hunk.changes, options, hunk.newStart - hunk.oldStart)
      : hunk.changes.map(changeToLine),
  };
};

const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/;

const extractHunkContext = (header: string): string =>
  HUNK_HEADER_REGEX.exec(header)?.[5]?.trim() ?? "";

const insertSkipBlocks = (hunks: Hunk[]): (Hunk | SkipBlock)[] => {
  const result: (Hunk | SkipBlock)[] = [];
  let lastHunkLine = 1;

  for (const hunk of hunks) {
    const distanceToLastHunk = hunk.oldStart - lastHunkLine;
    const context = extractHunkContext(hunk.content);
    if (distanceToLastHunk > 0) {
      result.push({
        count: distanceToLastHunk,
        type: "skip",
        content:
          context && context.length >= 5
            ? context
            : `${distanceToLastHunk} lines hidden`,
      });
    }
    lastHunkLine = Math.max(hunk.oldStart + hunk.oldLines, lastHunkLine);
    result.push(hunk);
  }

  return result;
};

const defaultOptions: ParseOptions = {
  maxDiffDistance: 30,
  maxChangeRatio: 0.45,
  mergeModifiedLines: true,
  inlineMaxCharEdits: INLINE_MAX_CHAR_EDITS,
};

// ============================================================================
// Main Functions
// ============================================================================

export function parseDiffWithHighlighting(
  patch: string,
  filename: string,
  previousFilename?: string,
  oldContent?: string,
  newContent?: string
): ParsedDiff {
  const diffHeader = `diff --git a/${filename} b/${filename}
--- a/${previousFilename || filename}
+++ b/${filename}
${patch}`;

  const opts = defaultOptions;
  const files = gitDiffParser.parse(diffHeader);
  const file = files[0];

  if (!file) {
    return { hunks: [] };
  }

  const language = guessLang(filename);
  const prevLanguage = previousFilename
    ? guessLang(previousFilename)
    : language;

  const rawHunks = insertSkipBlocks(
    file.hunks.map((hunk) => parseHunk(hunk, opts))
  );

  // When full-file contents are available, pre-highlight each side once so
  // multi-line constructs (raw strings, block comments, template literals)
  // carry the correct grammar state into every hunk. Without this, a hunk
  // that starts after a closing `"#` or `*/` feeds the highlighter a
  // fragment whose leading punctuation can be reinterpreted as an opening
  // token — flipping strings and code for the rest of the file.
  const newFileHighlighted = newContent
    ? highlightFileByLines(newContent, language)
    : null;
  const oldFileHighlighted = oldContent
    ? highlightFileByLines(oldContent, prevLanguage)
    : null;

  const hunks: (DiffHunk | DiffSkipBlock)[] = rawHunks.map((hunk) => {
    if (hunk.type === "skip") {
      return hunk as DiffSkipBlock;
    }

    // Fallback path: highlight just the hunk's lines together. Used when
    // full-file contents weren't provided. Multi-line constructs are still
    // colored correctly within the hunk, but a construct that opens/closes
    // outside the hunk can flip strings and code — full-file highlighting
    // above is what fixes that.
    const newBlockLines: string[] = [];
    const newBlockIndices: number[] = [];
    const oldBlockLines: string[] = [];
    const oldBlockIndices: number[] = [];
    if (!newFileHighlighted || !oldFileHighlighted) {
      for (let i = 0; i < hunk.lines.length; i++) {
        const line = hunk.lines[i];
        if (
          !newFileHighlighted &&
          (line.type === "normal" || line.type === "insert")
        ) {
          newBlockLines.push(
            line.content.length === 1
              ? (line.content[0]?.value ?? "")
              : line.content.map((s) => s.value).join("")
          );
          newBlockIndices.push(i);
        }
        if (
          !oldFileHighlighted &&
          (line.type === "normal" || line.type === "delete")
        ) {
          oldBlockLines.push(
            line.content.length === 1
              ? (line.content[0]?.value ?? "")
              : line.content.map((s) => s.value).join("")
          );
          oldBlockIndices.push(i);
        }
      }
    }
    const newBlockHighlighted = newFileHighlighted
      ? null
      : highlightFileByLines(newBlockLines.join("\n"), language);
    const oldBlockHighlighted = oldFileHighlighted
      ? null
      : highlightFileByLines(oldBlockLines.join("\n"), prevLanguage);

    const lookupNewHtml = (
      lineIndex: number,
      newNum: number | undefined,
      fallback: string
    ): string => {
      if (newFileHighlighted) {
        if (newNum != null && newFileHighlighted[newNum - 1] != null) {
          return newFileHighlighted[newNum - 1];
        }
        return highlight(fallback, language);
      }
      const idx = newBlockIndices.indexOf(lineIndex);
      if (idx >= 0 && newBlockHighlighted && idx < newBlockHighlighted.length) {
        return newBlockHighlighted[idx];
      }
      return highlight(fallback, language);
    };

    const lookupOldHtml = (
      lineIndex: number,
      oldNum: number | undefined,
      fallback: string,
      lineType: string
    ): string => {
      // For delete lines, always highlight directly — the full-file
      // content at oldNum-1 may not match the diff's old content
      // (file fetched from a different ref, or index shifted).
      if (lineType === "delete") {
        return highlight(fallback, prevLanguage);
      }
      if (oldFileHighlighted) {
        if (oldNum != null && oldFileHighlighted[oldNum - 1] != null) {
          return oldFileHighlighted[oldNum - 1];
        }
        return highlight(fallback, prevLanguage);
      }
      const idx = oldBlockIndices.indexOf(lineIndex);
      if (idx >= 0 && oldBlockHighlighted && idx < oldBlockHighlighted.length) {
        return oldBlockHighlighted[idx];
      }
      return highlight(fallback, prevLanguage);
    };

    return {
      type: "hunk" as const,
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      lines: hunk.lines.map((line, i): DiffLine => {
        let oldNum: number | undefined;
        let newNum: number | undefined;
        if (line.type === "normal") {
          oldNum = line.oldLineNumber;
          newNum = line.newLineNumber;
        } else if (line.type === "delete") {
          oldNum = line.lineNumber;
        } else {
          newNum = line.lineNumber;
        }

        const hasSingleSegment = line.content.length === 1;
        const singleSegmentIsNormal =
          hasSingleSegment && line.content[0].type === "normal";

        return {
          type: line.type,
          oldLineNumber: oldNum,
          newLineNumber: newNum,
          content: line.content.map((seg): LineSegment => {
            let html: string;

            if (singleSegmentIsNormal) {
              html =
                line.type === "delete"
                  ? lookupOldHtml(i, oldNum, seg.value, line.type)
                  : lookupNewHtml(i, newNum, seg.value);
            } else {
              // Multiple segments (inline diff) - highlight each segment individually
              // This is acceptable since inline diffs are usually small
              const segLang = seg.type === "delete" ? prevLanguage : language;
              html = highlight(seg.value, segLang);
            }

            return {
              value: seg.value,
              html,
              type: seg.type,
            };
          }),
        };
      }),
    };
  });

  return { hunks };
}

export function highlightFileLines(
  content: string,
  filename: string,
  startLine: number,
  oldStartLine: number,
  count: number
): DiffLine[] {
  const language = guessLang(filename);
  const allLines = content.split("\n");

  // Pre-highlight the entire file for proper context
  const highlightedLines = highlightFileByLines(content, language);

  // `split("\n")` on a file with a trailing newline produces a final "" entry
  // that is not a real line; treat it as EOF.
  const availableLines =
    allLines.length > 0 && allLines[allLines.length - 1] === ""
      ? allLines.length - 1
      : allLines.length;
  const remaining = Math.max(0, availableLines - startLine + 1);
  const effectiveCount = Math.min(count, remaining);

  const result: DiffLine[] = [];

  for (let i = 0; i < effectiveCount; i++) {
    const newLineNum = startLine + i;
    const oldLineNum = oldStartLine + i;
    const lineContent = allLines[newLineNum - 1] ?? "";
    // Use pre-highlighted HTML, fallback to individual highlighting
    const highlighted =
      highlightedLines[newLineNum - 1] ?? highlight(lineContent, language);

    result.push({
      type: "normal",
      oldLineNumber: oldLineNum,
      newLineNumber: newLineNum,
      content: [{ value: lineContent, html: highlighted, type: "normal" }],
    });
  }

  return result;
}

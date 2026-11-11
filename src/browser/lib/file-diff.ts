import {
  parsePatchFiles,
  type FileDiffMetadata,
  type SupportedLanguages,
} from "@pierre/diffs";
import type { PullRequestFile } from "../../api/types";
import { pairChangedLines } from "./line-pairing";

/**
 * Short, stable digest of `text` (cyrb53) for cache keys that must change with
 * the content without embedding it.
 */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Where each side of a (comparison) diff can be fetched from. */
export interface DiffSources {
  old: { sha: string; path: string; exists?: boolean };
  new: { sha: string; path: string; exists?: boolean };
}

/** A file's diff as the app holds it: Pierre's model plus app-level state. */
export interface LoadedDiff {
  fileDiff: FileDiffMetadata;
  error?: string;
  sources?: DiffSources;
}

export interface PatchInput {
  /** Hunk-only patch (starts at `@@`), as in `PullRequestFile.patch`. */
  patch: string;
  filename: string;
  previousFilename?: string;
  /** `PullRequestFile["status"]`; decides new/deleted/rename headers. */
  status?: PullRequestFile["status"];
  /** Key for Pierre's worker-pool render cache. Must change with the content. */
  cacheKey?: string;
}

function syntheticHeader({
  patch,
  filename,
  previousFilename,
  status,
}: Pick<PatchInput, "patch" | "filename" | "previousFilename" | "status">) {
  // A copy leaves the source in place, so it is not a rename. Pierre has no
  // copy type (it keeps `prevName` only for renames), so a copy is presented as
  // an ordinary change to the new path.
  const renamed =
    status !== "copied" &&
    (status === "renamed" ||
      (previousFilename !== undefined && previousFilename !== filename));
  const oldName = renamed ? (previousFilename ?? filename) : filename;
  const lines = [`diff --git a/${oldName} b/${filename}`];
  if (status === "added") {
    lines.push("new file mode 100644", "--- /dev/null", `+++ b/${filename}`);
  } else if (status === "removed") {
    lines.push("deleted file mode 100644", `--- a/${oldName}`, "+++ /dev/null");
  } else if (renamed) {
    // Pierre only reads the rename from "similarity index"/"rename" lines, and
    // only calls it a pure rename at 100%. Git omits ---/+++ for those.
    const pure = patch.trim() === "";
    lines.push(
      `similarity index ${pure ? 100 : 50}%`,
      `rename from ${oldName}`,
      `rename to ${filename}`
    );
    if (!pure) lines.push(`--- a/${oldName}`, `+++ b/${filename}`);
  } else {
    lines.push(`--- a/${oldName}`, `+++ b/${filename}`);
  }
  return lines.join("\n");
}

/**
 * Build Pierre's diff model from a hunk-only patch (GitHub's
 * `PullRequestFile.patch` and review-comment `diff_hunk` carry no file header)
 * by synthesizing the header Pierre's parser expects. An empty or unparseable
 * patch yields a diff with no hunks rather than throwing.
 */
export function fileDiffFromPatch(input: PatchInput): FileDiffMetadata {
  const header = syntheticHeader(input);
  const body = input.patch.trim() === "" ? "" : `${input.patch}\n`;
  const parse = (text: string) => {
    try {
      return parsePatchFiles(text)[0]?.files[0];
    } catch {
      return undefined;
    }
  };
  // Header alone parses to a hunk-less file with the right name/type, which is
  // also the fallback for a patch Pierre cannot make sense of.
  const fileDiff = parse(`${header}\n${body}`) ?? parse(`${header}\n`);
  if (!fileDiff) {
    throw new Error(`Failed to build a diff model for ${input.filename}`);
  }
  pairChangedLines(fileDiff);
  if (input.cacheKey !== undefined) fileDiff.cacheKey = input.cacheKey;
  return fileDiff;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Narrow a single-hunk patch to the lines around a review comment: from
 * `contextLines` before the start of the commented range through its last
 * line. A line is matched by its new-file number (additions, context) or its
 * old-file number (deletions). The kept lines are made contiguous.
 *
 * The hunk header is always rewritten from the kept lines, because GitHub's
 * review-comment `diff_hunk` is cut off at the commented line while its header
 * still declares the full hunk's counts. Without a line, or when nothing falls
 * in the window, the whole hunk is kept. A patch with no parseable hunk header
 * is returned unchanged.
 */
export function windowPatchAroundLines(
  patch: string,
  range: { line: number | null; startLine?: number | null },
  contextLines = 4
): string {
  const rows = patch.split("\n");
  if (rows.at(-1) === "") rows.pop();
  const headerAt = rows.findIndex((row) => row.startsWith("@@"));
  const header = headerAt >= 0 ? HUNK_HEADER.exec(rows[headerAt]!) : null;
  if (!header) return patch;

  const { line } = range;
  const rangeStart = line ? (range.startLine ?? line) - contextLines : 0;
  const rangeEnd = line ?? 0;

  interface Row {
    text: string;
    oldNo: number | null;
    newNo: number | null;
  }
  const body: Row[] = [];
  // An empty side (count 0) is numbered by the line before it.
  let oldNo = Number(header[1]) + (header[2] === "0" ? 1 : 0);
  let newNo = Number(header[3]) + (header[4] === "0" ? 1 : 0);
  for (const text of rows.slice(headerAt + 1)) {
    if (text.startsWith("@@")) break;
    const marker = text[0];
    if (marker === "\\") {
      body.push({ text, oldNo: null, newNo: null });
    } else if (marker === "+") {
      body.push({ text, oldNo: null, newNo: newNo++ });
    } else if (marker === "-") {
      body.push({ text, oldNo: oldNo++, newNo: null });
    } else {
      body.push({ text, oldNo: oldNo++, newNo: newNo++ });
    }
  }

  const inWindow = (row: Row) => {
    const lineNo = row.newNo ?? row.oldNo;
    return lineNo !== null && lineNo >= rangeStart && lineNo <= rangeEnd;
  };
  const found = line ? body.findIndex(inWindow) : -1;
  const firstIndex = Math.max(found, 0);
  let end = found < 0 ? body.length - 1 : body.findLastIndex(inWindow);
  // A "\ No newline at end of file" marker belongs to the line before it.
  while (body[end + 1]?.text.startsWith("\\")) end++;
  const kept = body.slice(firstIndex, end + 1);

  // Git numbers an empty side by the line before it.
  const startOf = (side: "oldNo" | "newNo", next: number) => {
    const first = kept.find((r) => r[side] !== null)?.[side];
    if (first != null) return first;
    const after = body.slice(firstIndex).find((r) => r[side] !== null)?.[side];
    return (after ?? next) - 1;
  };
  const oldCount = kept.filter((r) => r.oldNo !== null).length;
  const newCount = kept.filter((r) => r.newNo !== null).length;
  return [
    `@@ -${startOf("oldNo", oldNo)},${oldCount} +${startOf("newNo", newNo)},${newCount} @@${header[5]}`,
    ...kept.map((r) => r.text),
  ].join("\n");
}

/**
 * Pierre's hunk expansion state (`HunkExpansionRegion`), keyed by hunk index:
 * the key `i` is the unchanged region directly *before* `hunks[i]`, where
 * `fromStart` lines are revealed from the top of the region (below the
 * previous hunk) and `fromEnd` lines from its bottom (above hunk `i`). The
 * trailing region after the last hunk uses the key `hunks.length`; only
 * `fromStart` applies there.
 */
export type DiffExpansion = ReadonlyMap<
  number,
  { fromStart: number; fromEnd: number }
>;

export type DiffRow =
  | {
      kind: "line";
      type: "context" | "addition" | "deletion";
      oldLine: number | null;
      newLine: number | null;
      text: string;
      hunkIndex: number;
    }
  | {
      kind: "gap";
      /** Expansion key: the hunk the gap precedes, `hunks.length` for the trailing gap. */
      hunkIndex: number;
      /** Hidden lines. */
      count: number;
      /** First hidden line on each side. */
      oldStart: number;
      newStart: number;
    };

/**
 * Unchanged regions this small are always shown instead of collapsed. The
 * viewer passes the same value to Pierre as `collapsedContextThreshold`.
 */
export const DIFF_COLLAPSED_CONTEXT_THRESHOLD = 1;

const NO_EXPANSION: DiffExpansion = new Map();

/** `[start, end)` of the lines a hunk covers on one side, zero-based. */
function sideStart(start: number, count: number): number {
  return start - (count === 0 ? 0 : 1);
}

/**
 * Size of the unchanged region after the last hunk. Only known once the file
 * has been hydrated (a partial diff has no idea how long the file is).
 */
function trailingRangeSize(fileDiff: FileDiffMetadata): number {
  const last = fileDiff.hunks.at(-1);
  if (
    !last ||
    fileDiff.isPartial ||
    fileDiff.additionLines.length === 0 ||
    fileDiff.deletionLines.length === 0
  ) {
    return 0;
  }
  const additions =
    fileDiff.additionLines.length -
    (sideStart(last.additionStart, last.additionCount) + last.additionCount);
  const deletions =
    fileDiff.deletionLines.length -
    (sideStart(last.deletionStart, last.deletionCount) + last.deletionCount);
  // Pierre throws on a mismatch; there is nothing sensible to show for one.
  if (additions !== deletions) return 0;
  return Math.max(additions, 0);
}

interface GapSplit {
  /** Lines shown at the top of the region. */
  fromStart: number;
  /** Lines shown at the bottom of the region. */
  fromEnd: number;
  collapsed: number;
}

/** Mirrors Pierre's `getExpandedRegion`/`getTrailingExpandedRegion`. */
function splitGap(
  size: number,
  isPartial: boolean,
  region: { fromStart: number; fromEnd: number } | undefined,
  trailing: boolean
): GapSplit {
  if (size <= 0) return { fromStart: 0, fromEnd: 0, collapsed: 0 };
  if (isPartial) return { fromStart: 0, fromEnd: 0, collapsed: size };
  if (size <= DIFF_COLLAPSED_CONTEXT_THRESHOLD) {
    return { fromStart: size, fromEnd: 0, collapsed: 0 };
  }
  const fromStart = Math.min(Math.max(region?.fromStart ?? 0, 0), size);
  const fromEnd = trailing
    ? 0
    : Math.min(Math.max(region?.fromEnd ?? 0, 0), size);
  if (fromStart + fromEnd >= size) {
    return { fromStart: size, fromEnd: 0, collapsed: 0 };
  }
  return { fromStart, fromEnd, collapsed: size - fromStart - fromEnd };
}

const lineText = (raw: string | undefined): string =>
  (raw ?? "").replace(/\r?\n$/, "");

/**
 * Rows in unified display order (context, then a change block's deletions,
 * then its additions), honoring `expansion` exactly like Pierre renders the
 * unified view (same gap/threshold rules as its `iterateOverDiff`, which is
 * not part of Pierre's public API). Collapsed regions become `gap` rows;
 * revealed lines of a partially expanded region are ordinary context rows.
 * A partial (not yet hydrated) diff never has revealed regions and no
 * trailing gap, because the file length is unknown.
 */
export function diffRows(
  fileDiff: FileDiffMetadata,
  expansion: DiffExpansion = NO_EXPANSION
): DiffRow[] {
  const rows: DiffRow[] = [];
  const { hunks, isPartial, additionLines, deletionLines } = fileDiff;

  const context = (
    hunkIndex: number,
    oldLine: number,
    newLine: number,
    additionIndex: number
  ) =>
    rows.push({
      kind: "line",
      type: "context",
      oldLine,
      newLine,
      text: lineText(additionLines[additionIndex]),
      hunkIndex,
    });

  for (const [hunkIndex, hunk] of hunks.entries()) {
    const oldBoundary = sideStart(hunk.deletionStart, hunk.deletionCount);
    const newBoundary = sideStart(hunk.additionStart, hunk.additionCount);
    // Hydrated diffs index the full file, so a side with no lines of its own
    // starts at its boundary; partial ones index the compacted arrays.
    const oldIndex =
      !isPartial && hunk.deletionCount === 0
        ? oldBoundary
        : hunk.deletionLineIndex;
    const newIndex =
      !isPartial && hunk.additionCount === 0
        ? newBoundary
        : hunk.additionLineIndex;

    const size = Math.max(hunk.collapsedBefore, 0);
    const gap = splitGap(size, isPartial, expansion.get(hunkIndex), false);
    const gapOld = oldBoundary + 1 - size;
    const gapNew = newBoundary + 1 - size;
    for (let i = 0; i < gap.fromStart; i++) {
      context(hunkIndex, gapOld + i, gapNew + i, newIndex - size + i);
    }
    if (gap.collapsed > 0) {
      rows.push({
        kind: "gap",
        hunkIndex,
        count: gap.collapsed,
        oldStart: gapOld + gap.fromStart,
        newStart: gapNew + gap.fromStart,
      });
    }
    for (let i = gap.fromEnd; i > 0; i--) {
      context(
        hunkIndex,
        oldBoundary + 1 - i,
        newBoundary + 1 - i,
        newIndex - i
      );
    }

    let oldLine = oldBoundary + 1;
    let newLine = newBoundary + 1;
    let oldAt = oldIndex;
    let newAt = newIndex;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let i = 0; i < content.lines; i++) {
          context(hunkIndex, oldLine + i, newLine + i, newAt + i);
        }
        oldLine += content.lines;
        newLine += content.lines;
        oldAt += content.lines;
        newAt += content.lines;
        continue;
      }
      for (let i = 0; i < content.deletions; i++) {
        rows.push({
          kind: "line",
          type: "deletion",
          oldLine: oldLine + i,
          newLine: null,
          text: lineText(deletionLines[oldAt + i]),
          hunkIndex,
        });
      }
      for (let i = 0; i < content.additions; i++) {
        rows.push({
          kind: "line",
          type: "addition",
          oldLine: null,
          newLine: newLine + i,
          text: lineText(additionLines[newAt + i]),
          hunkIndex,
        });
      }
      oldLine += content.deletions;
      newLine += content.additions;
      oldAt += content.deletions;
      newAt += content.additions;
    }

    if (hunkIndex === hunks.length - 1) {
      const trailing = trailingRangeSize(fileDiff);
      const tail = splitGap(
        trailing,
        isPartial,
        expansion.get(hunks.length),
        true
      );
      for (let i = 0; i < tail.fromStart; i++) {
        context(hunks.length, oldLine + i, newLine + i, newAt + i);
      }
      if (tail.collapsed > 0) {
        rows.push({
          kind: "gap",
          hunkIndex: hunks.length,
          count: tail.collapsed,
          oldStart: oldLine + tail.fromStart,
          newStart: newLine + tail.fromStart,
        });
      }
    }
  }
  return rows;
}

/**
 * A diff that shows `text` as unchanged lines, for content that is not a real
 * change (the `:commit` metadata pseudo-file). It is a partial diff with one
 * hunk, so Pierre cannot expand it.
 */
export function contextOnlyFileDiff(
  name: string,
  text: string,
  opts: { lang?: SupportedLanguages; cacheKey?: string } = {}
): FileDiffMetadata {
  const lines = text === "" ? [] : text.split("\n");
  if (lines.at(-1) === "" && lines.length > 1) lines.pop();
  const patch =
    lines.length === 0
      ? ""
      : [
          `@@ -1,${lines.length} +1,${lines.length} @@`,
          ...lines.map((l) => ` ${l}`),
        ].join("\n");
  const fileDiff = fileDiffFromPatch({
    patch,
    filename: name,
    cacheKey: opts.cacheKey,
  });
  if (opts.lang) fileDiff.lang = opts.lang;
  return fileDiff;
}

/** A diff with no hunks: "no changes", or a file that could not be diffed. */
export function emptyLoadedDiff(
  filename: string,
  extra: Pick<LoadedDiff, "error" | "sources"> = {}
): LoadedDiff {
  return { fileDiff: fileDiffFromPatch({ patch: "", filename }), ...extra };
}

/**
 * A comparison (interdiff) of `filename` between two versions, from the
 * hunk-only patch `computeInterdiff` produced. `sources` says where each side
 * can be fetched from; a side that does not exist makes this an added or
 * removed file.
 */
export function comparisonLoadedDiff(
  patch: string,
  filename: string,
  sources: DiffSources
): LoadedDiff {
  const status =
    sources.old.exists === false
      ? "added"
      : sources.new.exists === false
        ? "removed"
        : undefined;
  return {
    fileDiff: fileDiffFromPatch({
      patch,
      filename,
      status,
      cacheKey: `cmp:${sources.old.sha}:${sources.old.path}:${sources.new.sha}:${sources.new.path}:${hashText(patch)}`,
    }),
    sources,
  };
}

const splitLines = (contents: string): string[] =>
  contents === "" ? [] : contents.split(/(?<=\n)/);

const sameLine = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined &&
  b !== undefined &&
  a.replace(/\r?\n$/, "") === b.replace(/\r?\n$/, "");

/** `[first, last+1)` zero-based indexes a hunk covers on one side. */
function hunkSpan(start: number, count: number): [begin: number, end: number] {
  const begin = sideStart(start, count);
  return [begin, begin + count];
}

/** True when `lines[at..]` starts with `expected`. */
function matchesAt(
  lines: readonly string[],
  at: number,
  expected: readonly string[]
): boolean {
  if (at < 0 || at + expected.length > lines.length) return false;
  return expected.every((line, i) => sameLine(line, lines[at + i]));
}

/**
 * Lines a hunk shows on one side (context plus that side's changes), read
 * from the partial diff's compact line arrays.
 */
function hunkSideLines(
  fileDiff: FileDiffMetadata,
  hunk: FileDiffMetadata["hunks"][number],
  side: "old" | "new"
): string[] {
  const source =
    side === "old" ? fileDiff.deletionLines : fileDiff.additionLines;
  const first =
    side === "old" ? hunk.deletionLineIndex : hunk.additionLineIndex;
  const count = side === "old" ? hunk.deletionCount : hunk.additionCount;
  return source.slice(first, first + count);
}

/**
 * Check that a partial diff's hunks really describe `contents` on one side:
 * every context and changed line of the patch sits where the hunk says it
 * does. Pierre replaces the patch's text with the file's when it hydrates, so
 * a file that is not the one the patch was computed for would show wrong lines.
 */
function sideMatchesHunks(
  fileDiff: FileDiffMetadata,
  contents: string,
  side: "old" | "new"
): boolean {
  const lines = splitLines(contents);
  return fileDiff.hunks.every((hunk) => {
    const [begin] =
      side === "old"
        ? hunkSpan(hunk.deletionStart, hunk.deletionCount)
        : hunkSpan(hunk.additionStart, hunk.additionCount);
    return matchesAt(lines, begin, hunkSideLines(fileDiff, hunk, side));
  });
}

/**
 * The file before a change, rebuilt from its `newContents` by undoing the
 * partial diff's hunks: unchanged stretches are copied from the new file and
 * each hunk contributes its own old-side lines. That is the exact pre-image
 * the patch was computed against (for a PR, the merge base's file), which
 * cannot be fetched from a ref the app knows. Null when `newContents` is not
 * the post-image the hunks describe, or the diff is already hydrated.
 */
export function reconstructPreImage(
  fileDiff: FileDiffMetadata,
  newContents: string
): string | null {
  if (!fileDiff.isPartial) return null;
  if (!sideMatchesHunks(fileDiff, newContents, "new")) return null;
  const newLines = splitLines(newContents);
  // Join per stretch rather than spreading lines into push(): an unchanged
  // stretch can exceed the engine's argument limit (e.g. large lockfiles).
  const parts: string[] = [];
  let next = 0;
  for (const hunk of fileDiff.hunks) {
    const [begin, end] = hunkSpan(hunk.additionStart, hunk.additionCount);
    if (begin < next) return null;
    parts.push(newLines.slice(next, begin).join(""));
    parts.push(hunkSideLines(fileDiff, hunk, "old").join(""));
    next = end;
  }
  parts.push(newLines.slice(next).join(""));
  return parts.join("");
}

/**
 * Whether two fetched versions of a file can hydrate a comparison diff
 * (whose hunks carry each version's own coordinates). Both must match their
 * side of every hunk, and every unchanged stretch between and after the hunks
 * must be equally long on both sides: Pierre assumes it is, and would number
 * or draw the lines of a shifted stretch wrongly. Returns why not, or null.
 */
export function comparisonContentsProblem(
  fileDiff: FileDiffMetadata,
  oldContents: string,
  newContents: string
): string | null {
  if (!sideMatchesHunks(fileDiff, oldContents, "old")) {
    return "the old version does not match the compared hunks";
  }
  if (!sideMatchesHunks(fileDiff, newContents, "new")) {
    return "the new version does not match the compared hunks";
  }
  let oldEnd = 0;
  let newEnd = 0;
  for (const hunk of fileDiff.hunks) {
    const [oldBegin, nextOldEnd] = hunkSpan(
      hunk.deletionStart,
      hunk.deletionCount
    );
    const [newBegin, nextNewEnd] = hunkSpan(
      hunk.additionStart,
      hunk.additionCount
    );
    if (oldBegin - oldEnd !== newBegin - newEnd) {
      return "the unchanged lines between hunks differ in length across versions";
    }
    oldEnd = nextOldEnd;
    newEnd = nextNewEnd;
  }
  if (
    splitLines(oldContents).length - oldEnd !==
    splitLines(newContents).length - newEnd
  ) {
    return "the versions end at different distances after the last hunk";
  }
  return null;
}

const baseRowsCache = new WeakMap<
  FileDiffMetadata,
  { isPartial: boolean; rows: DiffRow[] }
>();

/**
 * `diffRows(fileDiff)` without any expansion, computed once per diff (and
 * again after Pierre hydrates it in place). For callers that look at many
 * lines of the same diff, such as re-anchoring every comment of a file.
 */
export function baseDiffRows(fileDiff: FileDiffMetadata): DiffRow[] {
  const cached = baseRowsCache.get(fileDiff);
  if (cached && cached.isPartial === fileDiff.isPartial) return cached.rows;
  const rows = diffRows(fileDiff);
  baseRowsCache.set(fileDiff, { isPartial: fileDiff.isPartial, rows });
  return rows;
}

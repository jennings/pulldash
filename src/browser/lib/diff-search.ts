// Pure helpers powering the diff content search (Cmd/Ctrl+F in the changes
// view). All matching runs over data already in memory: the rows of the open
// file and the raw patch of every changed file. No network, no rendering
// changes — display speed is unaffected.

import type { FileDiffMetadata } from "@pierre/diffs";
import type { DiffRow } from "./file-diff";

/** A search hit. `start`/`end` are offsets into the line's text (no marker). */
export interface DiffSearchMatch {
  side: "old" | "new";
  /** Line number on `side`. */
  lineNumber: number;
  start: number;
  end: number;
  /** Hunk the line belongs to (for a gap, the hunk it precedes). */
  hunkIndex: number;
  /** The line is hidden in a collapsed gap: expand it to show the match. */
  inGap: boolean;
}

export interface PatchMatch extends DiffSearchMatch {
  filename: string;
}

function findRanges(
  text: string,
  needle: string,
  caseSensitive?: boolean
): Array<{ start: number; end: number }> {
  const hay = caseSensitive ? text : text.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  if (!n) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  let idx = hay.indexOf(n);
  while (idx !== -1) {
    ranges.push({ start: idx, end: idx + n.length });
    idx = hay.indexOf(n, idx + n.length);
  }
  return ranges;
}

/**
 * Find `query` in the rows of a file as Pierre shows them in unified mode, in
 * display order. A context line is reported on the new side; deletions on the
 * old side. When `fileDiff` has been hydrated with the full file text, lines
 * hidden in collapsed gaps are searched too and reported with `inGap`.
 */
export function searchRows(
  rows: readonly DiffRow[],
  query: string,
  opts?: { caseSensitive?: boolean; fileDiff?: FileDiffMetadata }
): DiffSearchMatch[] {
  const matches: DiffSearchMatch[] = [];
  if (!query) return matches;
  const hidden =
    opts?.fileDiff && !opts.fileDiff.isPartial
      ? opts.fileDiff.additionLines
      : null;
  for (const row of rows) {
    if (row.kind === "gap") {
      if (!hidden) continue;
      for (let i = 0; i < row.count; i++) {
        const lineNumber = row.newStart + i;
        const text = (hidden[lineNumber - 1] ?? "").replace(/\r?\n$/, "");
        for (const range of findRanges(text, query, opts?.caseSensitive)) {
          matches.push({
            side: "new",
            lineNumber,
            ...range,
            hunkIndex: row.hunkIndex,
            inGap: true,
          });
        }
      }
      continue;
    }
    const side = row.type === "deletion" ? "old" : "new";
    const lineNumber = side === "old" ? row.oldLine : row.newLine;
    if (lineNumber === null) continue;
    for (const range of findRanges(row.text, query, opts?.caseSensitive)) {
      matches.push({
        side,
        lineNumber,
        ...range,
        hunkIndex: row.hunkIndex,
        inGap: false,
      });
    }
  }
  return matches;
}

export interface PatchLineMatch {
  kind: "context" | "insert" | "delete";
  oldLine: number | null;
  newLine: number | null;
  text: string;
  /** Ordinal of the `@@` hunk the line is in. */
  hunkIndex: number;
}

// Walk a raw unified diff, tracking line numbers from @@ headers.
export function walkPatchLines(patch: string): PatchLineMatch[] {
  const out: PatchLineMatch[] = [];
  let oldLine = 0;
  let newLine = 0;
  let hunkIndex = -1;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      hunkIndex++;
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
      }
      continue;
    }
    if (
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("\\")
    ) {
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({
        kind: "insert",
        oldLine: null,
        newLine: newLine++,
        text: raw.slice(1),
        hunkIndex,
      });
    } else if (raw.startsWith("-")) {
      out.push({
        kind: "delete",
        oldLine: oldLine++,
        newLine: null,
        text: raw.slice(1),
        hunkIndex,
      });
    } else if (raw.startsWith(" ")) {
      out.push({
        kind: "context",
        oldLine: oldLine++,
        newLine: newLine++,
        text: raw.slice(1),
        hunkIndex,
      });
    }
    // "" (trailing newline artifact) is ignored
  }
  return out;
}

export function searchPatches(
  files: Array<{ filename: string; patch?: string }>,
  query: string,
  opts?: { caseSensitive?: boolean; excludeFilename?: string }
): PatchMatch[] {
  const matches: PatchMatch[] = [];
  if (!query) return matches;
  for (const file of files) {
    if (!file.patch || file.filename === opts?.excludeFilename) continue;
    for (const line of walkPatchLines(file.patch)) {
      for (const range of findRanges(line.text, query, opts?.caseSensitive)) {
        const side = line.kind === "delete" ? "old" : "new";
        matches.push({
          filename: file.filename,
          side,
          lineNumber: (side === "old" ? line.oldLine : line.newLine) ?? 0,
          ...range,
          hunkIndex: line.hunkIndex,
          inGap: false,
        });
      }
    }
  }
  return matches;
}

/**
 * Combine the open file's row matches with every other file's patch matches in
 * file-list order. The selected file is never searched in its patch: its rows
 * already include whatever the user expanded.
 */
export function mergeSearchMatches(
  files: Array<{ filename: string }>,
  selectedFile: string | null,
  rowMatches: DiffSearchMatch[],
  patchMatches: PatchMatch[]
): PatchMatch[] {
  const byFile = new Map<string, PatchMatch[]>();
  for (const match of patchMatches) {
    const matches = byFile.get(match.filename);
    if (matches) matches.push(match);
    else byFile.set(match.filename, [match]);
  }
  return files.flatMap((file) =>
    file.filename === selectedFile
      ? rowMatches.map((match) => ({ filename: file.filename, ...match }))
      : (byFile.get(file.filename) ?? [])
  );
}

// Pure helpers powering the diff content search (Cmd/Ctrl+F in the changes
// view). All matching runs over data already in memory: the parsed virtual
// rows of the open file and the raw patch of every changed file. No network,
// no virtualization changes — display speed is unaffected.

export interface SearchRange {
  start: number;
  length: number;
}

export interface SearchableSegment {
  value: string;
  type?: string;
}

export interface SearchableLine {
  type?: string;
  content: SearchableSegment[];
  oldLineNumber?: number | null;
  newLineNumber?: number | null;
}

export interface SearchableRow {
  type: string;
  line?: SearchableLine;
  pair?: {
    left?: SearchableLine | null;
    right?: SearchableLine | null;
  } | null;
}

export interface RowMatch {
  rowIndex: number;
  side: "old" | "new";
  oldLine: number | null;
  newLine: number | null;
  start: number;
  length: number;
}

export interface PatchMatch {
  filename: string;
  kind: "context" | "insert" | "delete";
  oldLine: number | null;
  newLine: number | null;
  start: number;
  length: number;
}

function findRanges(
  text: string,
  needle: string,
  caseSensitive?: boolean
): SearchRange[] {
  const hay = caseSensitive ? text : text.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  if (!n) return [];
  const ranges: SearchRange[] = [];
  let idx = hay.indexOf(n);
  while (idx !== -1) {
    ranges.push({ start: idx, length: n.length });
    idx = hay.indexOf(n, idx + n.length);
  }
  return ranges;
}

// Which side-space a segment advances: "new" content = normal + insert
// segments; "old" content = normal + delete segments.
function advances(side: "old" | "new", type?: string): boolean {
  return side === "new" ? type !== "delete" : type !== "insert";
}

// Map a range within a side's concatenated content back to per-segment
// ranges. Returns null when the side has no content at all.
export function mapRangeToSegments(
  segments: SearchableSegment[],
  side: "old" | "new",
  start: number,
  length: number
): Array<{ segIndex: number; start: number; length: number }> | null {
  const hits: Array<{ segIndex: number; start: number; length: number }> = [];
  let any = false;
  let offset = 0;
  const end = start + length;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!advances(side, seg.type)) continue;
    any = true;
    const segEnd = offset + seg.value.length;
    if (segEnd > start && offset < end) {
      const localStart = Math.max(0, start - offset);
      const localEnd = Math.min(seg.value.length, end - offset);
      if (localEnd > localStart) {
        hits.push({
          segIndex: i,
          start: localStart,
          length: localEnd - localStart,
        });
      }
    }
    offset = segEnd;
  }
  return any ? hits : null;
}

export function searchRows(
  rows: SearchableRow[],
  query: string,
  opts?: { caseSensitive?: boolean }
): RowMatch[] {
  const matches: RowMatch[] = [];
  if (!query) return matches;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (row.type === "line" && row.line) {
      const line = row.line;
      const mixed = line.content.some(
        (s) => s.type === "insert" || s.type === "delete"
      );
      // A merged modified row carries both old and new content; a pure
      // context row has identical old/new spaces, so only search "new".
      const sides: Array<"old" | "new"> =
        line.type === "insert"
          ? ["new"]
          : line.type === "delete"
            ? ["old"]
            : mixed
              ? ["new", "old"]
              : ["new"];
      for (const side of sides) {
        let text = "";
        for (const seg of line.content) {
          if (advances(side, seg.type)) text += seg.value;
        }
        for (const range of findRanges(text, query, opts?.caseSensitive)) {
          matches.push({
            rowIndex,
            side,
            oldLine:
              line.type === "insert" ? null : (line.oldLineNumber ?? null),
            newLine:
              line.type === "delete" ? null : (line.newLineNumber ?? null),
            ...range,
          });
        }
      }
    } else if (row.type === "split-line" && row.pair) {
      const { left, right } = row.pair;
      if (left) {
        let text = "";
        for (const seg of left.content) {
          if (advances("old", seg.type)) text += seg.value;
        }
        for (const range of findRanges(text, query, opts?.caseSensitive)) {
          matches.push({
            rowIndex,
            side: "old",
            oldLine: left.oldLineNumber ?? null,
            newLine: null,
            ...range,
          });
        }
      }
      if (right) {
        let text = "";
        for (const seg of right.content) {
          if (advances("new", seg.type)) text += seg.value;
        }
        for (const range of findRanges(text, query, opts?.caseSensitive)) {
          matches.push({
            rowIndex,
            side: "new",
            oldLine: null,
            newLine: right.newLineNumber ?? null,
            ...range,
          });
        }
      }
    }
  }
  return matches;
}

export interface PatchLineMatch {
  kind: "context" | "insert" | "delete";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

// Walk a raw unified diff, tracking line numbers from @@ headers.
export function walkPatchLines(patch: string): PatchLineMatch[] {
  const out: PatchLineMatch[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
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
      });
    } else if (raw.startsWith("-")) {
      out.push({
        kind: "delete",
        oldLine: oldLine++,
        newLine: null,
        text: raw.slice(1),
      });
    } else if (raw.startsWith(" ")) {
      out.push({
        kind: "context",
        oldLine: oldLine++,
        newLine: newLine++,
        text: raw.slice(1),
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
        matches.push({
          filename: file.filename,
          kind: line.kind,
          oldLine: line.oldLine,
          newLine: line.newLine,
          ...range,
        });
      }
    }
  }
  return matches;
}

export function mergeSearchMatches(
  files: Array<{ filename: string }>,
  selectedFile: string | null,
  rowMatches: RowMatch[],
  patchMatches: PatchMatch[]
): Array<Omit<RowMatch, "rowIndex"> & { filename: string; rowIndex?: number }> {
  const byFile = new Map<string, PatchMatch[]>();
  for (const match of patchMatches) {
    const matches = byFile.get(match.filename);
    if (matches) matches.push(match);
    else byFile.set(match.filename, [match]);
  }
  return files.flatMap((file) =>
    file.filename === selectedFile
      ? rowMatches.map((match) => ({ filename: file.filename, ...match }))
      : (byFile.get(file.filename) ?? []).map((match) => ({
          filename: match.filename,
          side: match.kind === "delete" ? ("old" as const) : ("new" as const),
          oldLine: match.oldLine,
          newLine: match.newLine,
          start: match.start,
          length: match.length,
        }))
  );
}

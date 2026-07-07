import gitDiffParser, {
  Hunk as _Hunk,
  Change as _Change,
  DeleteChange,
  InsertChange,
} from "gitdiff-parser";
import { diffArrays } from "diff";
import { refractor } from "refractor/all";
import { INLINE_MAX_CHAR_EDITS } from "../diff-parse-constants";
import {
  buildInlineDiffSegments,
  escapeHtml,
  hastToHtml,
  highlightFileByLines,
  tokenizeWords,
  type RawLineSegment,
} from "../shared/diff-utils";

// ============================================================================
// Types
// ============================================================================

export interface LineSegment {
  value: string;
  html: string; // Pre-highlighted HTML
  type: "insert" | "delete" | "normal";
}

type ReplaceKey<T, K extends PropertyKey, V> = T extends unknown
  ? Omit<T, K> & Record<K, V>
  : never;

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

type Line = ReplaceKey<_Change, "content", RawLineSegment[]>;

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
// Language Detection
// ============================================================================

const extToLang: Record<string, string> = {
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  mjs: "javascript",
  cjs: "javascript",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  py: "python",
  pyw: "python",
  pyi: "python",
  java: "java",
  kt: "kotlin",
  scala: "scala",
  groovy: "groovy",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  h: "cpp",
  hpp: "cpp",
  cs: "csharp",
  vb: "vbnet",
  fs: "fsharp",
  rs: "rust",
  go: "go",
  rb: "ruby",
  rake: "ruby",
  php: "php",
  phtml: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  md: "markdown",
  markdown: "markdown",
  tex: "latex",
  swift: "swift",
  m: "objectivec",
  mm: "objectivec",
  sql: "sql",
  r: "r",
  lua: "lua",
  perl: "perl",
  pl: "perl",
  dart: "dart",
  elm: "elm",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  clj: "clojure",
  cljs: "clojure",
  lisp: "lisp",
  hs: "haskell",
  ml: "ocaml",
  graphql: "graphql",
  proto: "protobuf",
  vim: "vim",
  zig: "zig",
};

function guessLang(filename?: string): string {
  const ext = filename?.split(".").pop()?.toLowerCase() ?? "";
  return extToLang[ext] ?? "tsx";
}

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

/**
 * Highlight a range of lines from file content.
 * Returns an array of DiffLine objects with syntax highlighting.
 */
export function highlightFileLines(
  content: string,
  filename: string,
  startLine: number,
  count: number
): DiffLine[] {
  const language = guessLang(filename);
  const allLines = content.split("\n");

  // Pre-highlight the entire file for proper context
  const highlightedLines = highlightFileByLines(content, language);

  const result: DiffLine[] = [];

  for (let i = 0; i < count; i++) {
    const lineNum = startLine + i;
    const lineContent = allLines[lineNum - 1] ?? "";
    // Use pre-highlighted HTML, fallback to individual highlighting
    const highlighted =
      highlightedLines[lineNum - 1] ?? highlight(lineContent, language);

    result.push({
      type: "normal",
      oldLineNumber: lineNum,
      newLineNumber: lineNum,
      content: [{ value: lineContent, html: highlighted, type: "normal" }],
    });
  }

  return result;
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

const isSimilarEnough = (
  a: string,
  b: string,
  maxChangeRatio: number
): boolean => {
  if (maxChangeRatio <= 0) return a === b;
  if (maxChangeRatio >= 1) return true;
  return calculateChangeRatio(a, b) <= maxChangeRatio;
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

  for (const addIdx of insertIdxs) {
    const add = changes[addIdx] as InsertChange;
    if (pairOfAdd[addIdx] !== UNPAIRED) continue;
    if (addIdx < delIdx) continue;

    const ratio = calculateChangeRatio(del.content, add.content);
    if (ratio > options.maxChangeRatio) continue;
    if (ratio < bestRatio) {
      bestRatio = ratio;
      bestAddIdx = addIdx;
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

function buildUnpairedDeletePrefix(changes: _Change[], pairOfDel: Int32Array) {
  const n = changes.length;
  const prefix = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const c = changes[i];
    const isInitiallyUnpairedDelete =
      c.type === "delete" && pairOfDel[i] === UNPAIRED;
    prefix[i + 1] = prefix[i] + (isInitiallyUnpairedDelete ? 1 : 0);
  }
  return prefix;
}

function hasUnpairedDeleteBetween(
  unpairedDelPrefix: Int32Array,
  deleteIdx: number,
  insertIdx: number
) {
  const lower = Math.max(0, deleteIdx);
  const upper = Math.max(lower, insertIdx);
  return unpairedDelPrefix[upper] - unpairedDelPrefix[lower] > 0;
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
  unpairedDelPrefix: Int32Array,
  options: ParseOptions
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
      } else if (pairedAddIdx > i) {
        const shouldUnpair = hasUnpairedDeleteBetween(
          unpairedDelPrefix,
          i + 1,
          pairedAddIdx
        );
        if (shouldUnpair) {
          pairOfAdd[pairedAddIdx] = UNPAIRED;
          processed[i] = 1;
          emitNormal(out, c);
        } else {
          processed[i] = 1;
        }
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

  const deletePosition = new Map<Line, number>();
  for (let i = 0; i < out.length; i++) {
    const line = out[i];
    if ((line as any).newLineNumber != null) continue;
    if (line.type !== "delete") continue;
    for (let j = i + 1; j < out.length; j++) {
      const next = out[j];
      const n = (next as any).newLineNumber;
      if (n != null) {
        deletePosition.set(line, n);
        break;
      }
    }
  }

  const result = [...out, ...unpairedInserts];
  result.sort((a, b) => {
    const aPos =
      (a as any).newLineNumber ??
      deletePosition.get(a) ??
      (a as any).lineNumber ??
      -Infinity;
    const bPos =
      (b as any).newLineNumber ??
      deletePosition.get(b) ??
      (b as any).lineNumber ??
      -Infinity;
    if (aPos !== bPos) return aPos - bPos;
    return 0;
  });

  for (let i = 0; i < result.length - 1; i++) {
    const a = result[i];
    const b = result[i + 1];
    if (
      a.type === "delete" &&
      b.type === "insert" &&
      a.content.length === 1 &&
      b.content.length === 1 &&
      a.content[0].value.trim() === "" &&
      b.content[0].value.trim() === ""
    ) {
      result[i] = {
        type: "normal",
        isNormal: true,
        oldLineNumber: (a as any).lineNumber,
        newLineNumber: (b as any).lineNumber,
        content: b.content,
      } as Line;
      result.splice(i + 1, 1);
      i--;
    }
  }

  return result;
}

function mergeModifiedLines(changes: _Change[], options: ParseOptions): Line[] {
  const { insertIdxs, deleteIdxs } = buildChangeIndices(changes);
  const { pairOfDel, pairOfAdd } = buildInitialPairs(
    changes,
    insertIdxs,
    deleteIdxs,
    options
  );
  const unpairedDelPrefix = buildUnpairedDeletePrefix(changes, pairOfDel);

  for (const di of deleteIdxs) {
    if (pairOfDel[di] !== UNPAIRED) continue;
    const del = changes[di] as DeleteChange;
    for (const ai of insertIdxs) {
      if (pairOfAdd[ai] !== UNPAIRED) continue;
      if (ai < di) continue;
      const add = changes[ai] as InsertChange;
      if (del.content.trim() !== add.content.trim()) continue;
      if (del.content.trim() === "") continue;
      pairOfDel[di] = ai;
      pairOfAdd[ai] = di;
      break;
    }
  }

  return emitLines(changes, pairOfDel, pairOfAdd, unpairedDelPrefix, options);
}

const parseHunk = (hunk: _Hunk, options: ParseOptions): Hunk => {
  return {
    ...hunk,
    type: "hunk",
    lines: options.mergeModifiedLines
      ? mergeModifiedLines(hunk.changes, options)
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
        content: context ?? hunk.content,
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
// Main Export
// ============================================================================

// Cache for parsed diffs (keyed by SHA)
const diffCache = new Map<string, ParsedDiff>();
const MAX_CACHE_SIZE = 500;

export function parseDiffWithHighlighting(
  patch: string,
  filename: string,
  previousFilename?: string,
  cacheKey?: string,
  oldContent?: string,
  newContent?: string
): ParsedDiff {
  // Check cache
  if (cacheKey && diffCache.has(cacheKey)) {
    return diffCache.get(cacheKey)!;
  }

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

  // Pre-highlight full files if content is provided
  // This ensures proper highlighting for multi-line constructs (strings, comments, etc.)
  const oldHighlightedLines = oldContent
    ? highlightFileByLines(oldContent, prevLanguage)
    : null;
  const newHighlightedLines = newContent
    ? highlightFileByLines(newContent, language)
    : null;

  const rawHunks = insertSkipBlocks(
    file.hunks.map((hunk) => parseHunk(hunk, opts))
  );

  // Convert to output format with highlighting
  const hunks: (DiffHunk | DiffSkipBlock)[] = rawHunks.map((hunk) => {
    if (hunk.type === "skip") {
      return hunk as DiffSkipBlock;
    }

    return {
      type: "hunk" as const,
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      lines: hunk.lines.map((line): DiffLine => {
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

        // For lines with a single segment (no inline diff), use pre-highlighted content
        // For lines with multiple segments (inline diff), highlight each segment
        const hasSingleSegment = line.content.length === 1;
        const singleSegmentIsNormal =
          hasSingleSegment && line.content[0].type === "normal";

        return {
          type: line.type,
          oldLineNumber: oldNum,
          newLineNumber: newNum,
          content: line.content.map((seg) => {
            let html: string;

            // Try to use pre-highlighted content for better context
            if (singleSegmentIsNormal) {
              // Use pre-highlighted line if available
              if (
                line.type === "delete" &&
                oldHighlightedLines &&
                oldNum !== undefined
              ) {
                html =
                  oldHighlightedLines[oldNum - 1] ??
                  highlight(seg.value, prevLanguage);
              } else if (
                line.type === "insert" &&
                newHighlightedLines &&
                newNum !== undefined
              ) {
                html =
                  newHighlightedLines[newNum - 1] ??
                  highlight(seg.value, language);
              } else if (
                line.type === "normal" &&
                newHighlightedLines &&
                newNum !== undefined
              ) {
                // For normal lines, prefer new file highlighting (same content in both)
                html =
                  newHighlightedLines[newNum - 1] ??
                  highlight(seg.value, language);
              } else {
                html = highlight(seg.value, language);
              }
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

  const result: ParsedDiff = { hunks };

  // Cache result
  if (cacheKey) {
    if (diffCache.size >= MAX_CACHE_SIZE) {
      const keysToDelete = Array.from(diffCache.keys()).slice(0, 100);
      keysToDelete.forEach((k) => diffCache.delete(k));
    }
    diffCache.set(cacheKey, result);
  }

  return result;
}

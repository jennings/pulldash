/**
 * Resolve where to display a PR review comment when the diff being shown is
 * not the commit the comment was made on.
 *
 * GitHub's `pull-request-review-comment` returns `line` in the coordinates of
 * `commit_id` (where the comment was originally made). When the diff being
 * viewed comes from a different commit, that line number points to unrelated
 * content. To restore the comment's intended position, find the comment's
 * anchored content (the trailing lines of its `diff_hunk`) in the current
 * view's parsed diff and use that line number instead.
 */

import type { ParsedDiff } from "./diff-worker";

export interface CommentAnchorInput {
  side?: "LEFT" | "RIGHT" | null;
  line?: number | null;
  startLine?: number | null;
  diffHunk?: string | null;
}

const MIN_MATCH_LINES = 3;

/**
 * SHAs match when one equals the other or one is a prefix of the other.
 * GitHub mixes full 40-char SHAs and 7-char prefixes across endpoints.
 */
export function commitShasMatch(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * Extract the post- or pre-image content lines (depending on `side`) from a
 * unified diff hunk string, stripping the leading `+`/`-`/` ` marker.
 */
function extractSideContent(
  diffHunk: string,
  side: "LEFT" | "RIGHT"
): string[] {
  const lines: string[] = [];
  for (const line of diffHunk.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith("@@")) continue;
    const marker = line[0];
    if (side === "RIGHT" && (marker === "+" || marker === " ")) {
      lines.push(line.substring(1));
    } else if (side === "LEFT" && (marker === "-" || marker === " ")) {
      lines.push(line.substring(1));
    }
  }
  return lines;
}

function findSliceInDiff(
  slice: string[],
  parsedDiff: ParsedDiff,
  side: "LEFT" | "RIGHT"
): number | null {
  for (const hunk of parsedDiff.hunks) {
    if (hunk.type !== "hunk") continue;

    const sideLines = hunk.lines.filter((l) =>
      side === "RIGHT"
        ? l.type === "insert" || l.type === "normal"
        : l.type === "delete" || l.type === "normal"
    );

    for (let i = 0; i <= sideLines.length - slice.length; i++) {
      let matched = true;
      for (let j = 0; j < slice.length; j++) {
        const content = sideLines[i + j].content.map((s) => s.value).join("");
        if (content !== slice[j]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        const last = sideLines[i + slice.length - 1];
        const lineNum =
          side === "RIGHT" ? last.newLineNumber : last.oldLineNumber;
        return lineNum ?? null;
      }
    }
  }
  return null;
}

/**
 * Find the line number in `parsedDiff` that contains the same content the
 * comment was anchored to. Returns null when no match is found (the line was
 * removed, lives inside a collapsed skip block, or differs by even a single
 * character).
 */
export function resolveCommentLineFromDiffHunk(
  comment: CommentAnchorInput,
  parsedDiff: ParsedDiff
): number | null {
  if (!comment.diffHunk || !comment.line) return null;
  const side = (comment.side ?? "RIGHT") as "LEFT" | "RIGHT";

  const sideContent = extractSideContent(comment.diffHunk, side);
  if (sideContent.length === 0) return null;

  const anchorCount = Math.max(
    1,
    comment.line - (comment.startLine ?? comment.line) + 1
  );

  // Prefer matching with extra context lines for uniqueness; fall back to the
  // anchor alone if that fails (common when the surrounding context changed).
  const withContext = Math.min(
    Math.max(anchorCount, MIN_MATCH_LINES),
    sideContent.length
  );
  const withContextSlice = sideContent.slice(-withContext);
  const matched = findSliceInDiff(withContextSlice, parsedDiff, side);
  if (matched !== null) return matched;

  if (withContext > anchorCount) {
    const anchorOnly = sideContent.slice(-anchorCount);
    return findSliceInDiff(anchorOnly, parsedDiff, side);
  }
  return null;
}

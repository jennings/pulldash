import type { Review } from "@/api/types";

/**
 * Latest review per user, mirroring how GitHub displays reviewer state (and
 * its `latestOpinionatedReviews` field): the most recent APPROVED or
 * CHANGES_REQUESTED review decides; later COMMENTED reviews do not override
 * the decision. Comment-only reviewers fall back to their latest comment.
 */
export function getLatestReviewByUser(reviews: Review[]): Map<string, Review> {
  const sorted = reviews
    .filter((r) => r.user && r.submitted_at)
    .sort(
      (a, b) =>
        new Date(a.submitted_at!).getTime() -
        new Date(b.submitted_at!).getTime()
    );

  const decisions = new Map<string, Review>();
  const comments = new Map<string, Review>();
  for (const review of sorted) {
    if (!review.user) continue;
    if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") {
      decisions.set(review.user.login, review);
    } else if (review.state === "DISMISSED") {
      // Dismissal revokes the user's decision entirely (GitHub's
      // latestOpinionatedReviews only surfaces non-dismissed reviews).
      decisions.delete(review.user.login);
    } else if (review.state === "COMMENTED") {
      comments.set(review.user.login, review);
    }
  }

  // Decisions win; comment-only reviewers fall back to their latest comment.
  const byUser = new Map(decisions);
  for (const [login, review] of comments) {
    if (!byUser.has(login)) byUser.set(login, review);
  }
  return byUser;
}

/** Decision reviews only (no COMMENTED entries) — approvals and change
 *  requests per user, used for approval counts and the merge box. */
export function getLatestReviewsByUser(reviews: Review[]): Review[] {
  return [...getLatestReviewByUser(reviews).values()].filter(
    (r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED"
  );
}

/** Group comments by `${line}:${side}`. A line number can exist on both
 *  sides of the diff, so the side must be part of the key — otherwise a
 *  comment renders under both the old and the new row. */
export function groupCommentsByLineSide<
  T extends { line: number; side: "LEFT" | "RIGHT" },
>(comments: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const comment of comments) {
    const key = `${comment.line}:${comment.side === "LEFT" ? "old" : "new"}`;
    const existing = map.get(key) || [];
    existing.push(comment);
    map.set(key, existing);
  }
  return map;
}

export interface CommentPosition {
  line: number;
  start_line?: number;
  side: "LEFT" | "RIGHT";
}

export interface ResolvedCommentPosition {
  line: number;
  start_line?: number;
  adjusted: boolean;
}

/** [start, end] line ranges present in a unified diff patch for one side.
 *  Each hunk header spans a contiguous run of lines on that side. */
function diffLineRanges(
  patch: string,
  side: "LEFT" | "RIGHT"
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (const match of patch.matchAll(header)) {
    const start = Number(side === "LEFT" ? match[1] : match[3]);
    const count = Number((side === "LEFT" ? match[2] : match[4]) ?? "1");
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  return ranges;
}

function nearestLine(line: number, ranges: Array<[number, number]>): number {
  let best = line;
  let bestDistance = Infinity;
  for (const [start, end] of ranges) {
    if (line >= start && line <= end) return line;
    const candidate = line < start ? start : end;
    const distance = Math.abs(candidate - line);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function rangeIndex(line: number, ranges: Array<[number, number]>): number {
  return ranges.findIndex(([start, end]) => line >= start && line <= end);
}

/**
 * GitHub rejects review comments anchored to lines outside the diff with
 * "Line could not be resolved" (e.g. comments on context revealed by expanding
 * a skip block). Snap such comments to the nearest line that is part of the
 * patch so submission succeeds. Comments already inside the diff are returned
 * unchanged.
 */
export function resolveCommentPosition(
  comment: CommentPosition,
  patch: string | null | undefined
): ResolvedCommentPosition {
  if (!patch)
    return {
      line: comment.line,
      start_line: comment.start_line,
      adjusted: false,
    };
  const ranges = diffLineRanges(patch, comment.side);
  if (ranges.length === 0) {
    return {
      line: comment.line,
      start_line: comment.start_line,
      adjusted: false,
    };
  }

  const line = nearestLine(comment.line, ranges);
  const lineMoved = line !== comment.line;
  if (comment.start_line === undefined) {
    return { line, adjusted: lineMoved };
  }

  const start = nearestLine(comment.start_line, ranges);
  // GitHub requires both endpoints to belong to the same diff hunk. A moved
  // range can also collapse or invert, so fall back to a single-line comment.
  if (
    lineMoved ||
    start !== comment.start_line ||
    start >= line ||
    rangeIndex(start, ranges) !== rangeIndex(line, ranges)
  ) {
    return { line, adjusted: true };
  }
  return { line, start_line: start, adjusted: false };
}

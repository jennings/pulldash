import type { PullRequestFile, ReviewComment } from "@/api/types";
import { resolveCommentPosition } from "./reviews";
import { stripReviewGroupMarker } from "@/shared/review-group";

export interface SubmitCommentPayload {
  path: string;
  line: number;
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  side: "LEFT" | "RIGHT";
  body: string;
}

/** Local pending comment fields needed for submission. */
export interface PendingCommentInput {
  id: string;
  path: string;
  line: number;
  start_line?: number;
  body: string;
  side: "LEFT" | "RIGHT";
  start_side?: "LEFT" | "RIGHT";
  /** Commit view (or push-version view) the comment was made on. */
  targetSha?: string;
  databaseId?: number;
  nodeId?: string;
}

/** The commit a comment should be anchored to; the PR head when undefined. */
export function pendingTargetSha(
  comment: PendingCommentInput,
  headSha: string
): string {
  return comment.targetSha ?? headSha;
}

export interface PreparedComment {
  comment: PendingCommentInput;
  payload: SubmitCommentPayload;
}

export interface PreparedGroup {
  sha: string;
  comments: PreparedComment[];
}

const FIRST_HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)/m;

/** Group pending comments by the commit they were made on. The head group
 *  goes first so the review summary body lands on the head-anchored review;
 *  remaining groups keep creation order. */
export function groupPendingCommentsByTarget(
  comments: PendingCommentInput[],
  headSha: string
): Array<{ sha: string; comments: PendingCommentInput[] }> {
  const bySha = new Map<string, PendingCommentInput[]>();
  for (const comment of comments) {
    const sha = pendingTargetSha(comment, headSha);
    const list = bySha.get(sha) ?? [];
    list.push(comment);
    bySha.set(sha, list);
  }
  const head = bySha.get(headSha);
  const others = [...bySha].filter(([sha]) => sha !== headSha);
  return [...(head ? [[headSha, head] as const] : []), ...others].map(
    ([sha, list]) => ({ sha, comments: list })
  );
}

/** Repo context for building permalinks in moved-comment notes. */
export interface PermalinkContext {
  owner: string;
  repo: string;
  sha: string;
}

/** Prepare REST payloads for one commit group. :commit metadata comments
 *  redirect to the first file of the group's diff; comments on lines outside
 *  the diff snap to the nearest line GitHub will accept. GitHub validates
 *  every comment of a review against the cumulative diff at the review's
 *  commit and rejects the whole review otherwise, so lines must be pre-snapped.
 *  (GitHub's web UI anchors out-of-diff comments exactly because it uses an
 *  internal endpoint; the public API always rejects them with 422.) */
export function prepareGroupComments(
  comments: PendingCommentInput[],
  files: PullRequestFile[],
  permalink?: PermalinkContext
): PreparedComment[] {
  if (comments.some((c) => c.path === ":commit") && files.length === 0) {
    throw new Error(
      "Cannot submit commit-metadata comments when the pull request has no files"
    );
  }
  const firstFile = files[0];
  const firstHunkLine = firstFile?.patch?.match(FIRST_HUNK_RE)?.[1];
  const metadataLine = firstHunkLine ? parseInt(firstHunkLine, 10) : 1;

  return comments.map((comment) => {
    if (comment.path === ":commit" && firstFile) {
      return {
        comment,
        payload: {
          path: firstFile.filename,
          line: metadataLine,
          side: "RIGHT" as const,
          body: comment.body,
        },
      };
    }
    const file = files.find((f) => f.filename === comment.path);
    const anchor = resolveCommentPosition(
      {
        line: comment.line,
        start_line: comment.start_line,
        side: comment.side,
      },
      file?.patch
    );
    const movedNote = ((): string | null => {
      if (!anchor.adjusted) return null;
      const range =
        comment.start_line !== undefined && comment.start_line !== comment.line
          ? `lines ${comment.start_line}-${comment.line}`
          : `line ${comment.line}`;
      if (permalink) {
        const anchorPart =
          comment.start_line !== undefined &&
          comment.start_line !== comment.line
            ? `#L${comment.start_line}-L${comment.line}`
            : `#L${comment.line}`;
        const href = `https://github.com/${permalink.owner}/${permalink.repo}/blob/${permalink.sha}/${comment.path}${anchorPart}`;
        return `_This comment was originally on [${range} of \`${comment.path}\`](${href}), which is outside the diff — GitHub's API can only anchor review comments to diff lines, so it was moved to the nearest one._`;
      }
      return `_This comment was originally on ${range} of \`${comment.path}\`, which is outside the diff — GitHub's API can only anchor review comments to diff lines, so it was moved to the nearest one._`;
    })();
    return {
      comment,
      payload: {
        path: comment.path,
        line: anchor.line,
        start_line: anchor.start_line,
        start_side: anchor.start_line === undefined ? undefined : comment.side,
        side: comment.side,
        body: movedNote ? `${movedNote}\n\n${comment.body}` : comment.body,
      },
    };
  });
}

/** Content key for a submitted comment, ignoring the diff side. Used to spot
 *  already-submitted comments in refetched threads. The review-group marker is
 *  regenerated per submission attempt, so it must not participate. */
export function submittedCommentKey(
  path: string,
  line: number | null | undefined,
  startLine: number | null | undefined,
  body: string
): string {
  return `${path}:${line}:${startLine ?? ""}:${stripReviewGroupMarker(body)}`;
}

/** Match a set of just-submitted review comments against the payloads we sent,
 *  so a retried submission can skip groups that already made it to GitHub. */
export function sameSubmittedComments(
  submitted: ReviewComment[],
  payloads: SubmitCommentPayload[]
): boolean {
  if (submitted.length !== payloads.length) return false;
  // The review-group marker is regenerated per submission attempt, so it
  // must not participate in the comparison. A missing side on the response
  // counts as RIGHT.
  const key = (
    path: string,
    line: number | null | undefined,
    side: string | null | undefined,
    startLine: number | null | undefined,
    body: string
  ) =>
    `${path}:${line}:${side ?? "RIGHT"}:${startLine ?? ""}:${stripReviewGroupMarker(body)}`;
  const sent = new Set(
    payloads.map((p) => key(p.path, p.line, p.side, p.start_line, p.body))
  );
  const got = new Set(
    submitted.map((c) => key(c.path, c.line, c.side, c.start_line, c.body))
  );
  return sent.size === got.size && [...sent].every((k) => got.has(k));
}

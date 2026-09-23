import type { PullRequestFile, ReviewComment } from "@/api/types";
import { resolveCommentPosition } from "./reviews";
import { stripReviewGroupMarker } from "@/shared/review-group";
import { buildOutOfDiffMarker } from "@/shared/out-of-diff";

export interface SubmitCommentPayload {
  path: string;
  /** Undefined for file-level comments (lines outside the diff hunks). */
  line?: number;
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  side: "LEFT" | "RIGHT";
  body: string;
  subject_type?: "file";
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

/** Repo context for building permalinks in file-level comment bodies. */
export interface PermalinkContext {
  owner: string;
  repo: string;
  sha: string;
}

/** Prepare REST payloads for one commit group. :commit metadata comments
 *  redirect to the first file of the group's diff. Comments on lines outside
 *  the diff hunks cannot be line-anchored — GitHub's API rejects them with
 *  422 ("Line could not be resolved") in every submission path, and its web
 *  UI anchors them exactly through an internal endpoint. They are submitted
 *  as file-level comments (subject_type: file, no line); the body carries a
 *  hidden marker with the real position for pulldash to re-anchor, plus a
 *  blob permalink GitHub renders as an embedded code snippet. */
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
    if (anchor.adjusted) {
      // Out-of-diff line: submit as a file-level comment carrying the real
      // position in a hidden marker, plus a blob permalink (GitHub embeds the
      // referenced code range in the rendered comment).
      const anchorPart =
        comment.start_line !== undefined && comment.start_line !== comment.line
          ? `#L${comment.start_line}-L${comment.line}`
          : `#L${comment.line}`;
      const parts = [
        buildOutOfDiffMarker(comment.line, comment.start_line, comment.side),
        comment.body,
      ];
      if (permalink) {
        parts.push(
          `https://github.com/${permalink.owner}/${permalink.repo}/blob/${permalink.sha}/${comment.path}${anchorPart}`
        );
      }
      return {
        comment,
        payload: {
          path: comment.path,
          body: parts.join("\n\n"),
          side: comment.side,
          subject_type: "file" as const,
        },
      };
    }
    return {
      comment,
      payload: {
        path: comment.path,
        line: anchor.line,
        start_line: anchor.start_line,
        start_side: anchor.start_line === undefined ? undefined : comment.side,
        side: comment.side,
        body: comment.body,
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

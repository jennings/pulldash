import type { PullRequestFile, ReviewComment } from "@/api/types";
import {
  useGitHub,
  type Review,
  type ReviewThread,
  type TimelineEvent,
} from "@/browser/contexts/github";
import {
  usePRReviewStore,
  usePRReviewSelector,
  type LocalPendingComment,
} from ".";
import { setLastViewed } from "@/browser/lib/waiting-prs";
import { markSelfActivity } from "@/browser/lib/notifications";
import { resolveCommentPosition } from "@/browser/lib/reviews";

interface SubmitCommentPayload {
  path: string;
  line: number;
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  side: "LEFT" | "RIGHT";
  body: string;
}

/** Map local pending comments to a GitHub payload, redirecting :commit
 *  metadata comments to the first real file and snapping comments whose line
 *  is outside the diff to the nearest line GitHub will accept. */
function prepareSubmitComment(
  comment: LocalPendingComment,
  files: PullRequestFile[],
  firstFilename: string | undefined,
  metadataLine: number
): { comment: LocalPendingComment; payload: SubmitCommentPayload } {
  const isMetadata = comment.path === ":commit" && firstFilename;
  const path = isMetadata ? firstFilename : comment.path;
  const side = isMetadata ? "RIGHT" : comment.side;
  const file = files.find((f) => f.filename === path);
  const anchor = resolveCommentPosition(
    {
      line: isMetadata ? metadataLine : comment.line,
      start_line: isMetadata ? undefined : comment.start_line,
      side,
    },
    file?.patch
  );

  return {
    comment,
    payload: {
      path,
      line: anchor.line,
      start_line: anchor.start_line,
      start_side: anchor.start_line === undefined ? undefined : side,
      side,
      body:
        !isMetadata && anchor.adjusted
          ? `_This comment was originally on line ${comment.line}, which is outside the diff; it was moved to the nearest diff line when submitting._\n\n${comment.body}`
          : comment.body,
    },
  };
}

/** Represent a just-submitted comment as a thread so it renders under its
 *  review before the review-threads query catches up. Uses the submitted
 *  payload (post redirect/snap) so REST-fallback comments — which never got
 *  GitHub IDs — still render immediately. */
function pendingCommentToThread(
  comment: LocalPendingComment,
  reviewId: number,
  author: { login: string; avatarUrl: string } | null,
  timestamp: string,
  payload?: SubmitCommentPayload
): ReviewThread {
  return {
    id: `pending-thread-${comment.id}`,
    isResolved: false,
    isOutdated: false,
    resolvedBy: null,
    pullRequestReview: { databaseId: reviewId, author },
    comments: {
      nodes: [
        {
          id: comment.nodeId ?? comment.id,
          databaseId: comment.databaseId ?? 0,
          body: payload?.body ?? comment.body,
          path: payload?.path ?? comment.path,
          line: payload?.line ?? comment.line,
          originalLine: payload?.line ?? comment.line,
          startLine: payload?.start_line ?? comment.start_line ?? null,
          diffHunk: null,
          originalCommit: null,
          author,
          createdAt: timestamp,
          updatedAt: timestamp,
          replyTo: null,
        },
      ],
    },
  };
}

function submittedGraphQLReviewToReview(
  submitted: {
    databaseId: number;
    state?: string;
    submittedAt: string | null;
  },
  currentUser: string | null
): Review {
  return {
    id: submitted.databaseId,
    user: currentUser
      ? {
          login: currentUser,
          avatar_url: `https://avatars.githubusercontent.com/${currentUser}`,
        }
      : null,
    state:
      submitted.state === "APPROVED"
        ? "APPROVED"
        : submitted.state === "CHANGES_REQUESTED"
          ? "CHANGES_REQUESTED"
          : "COMMENTED",
    submitted_at: submitted.submittedAt,
  } as Review;
}

export function useReviewActions() {
  const store = usePRReviewStore();
  const github = useGitHub();
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const pr = usePRReviewSelector((s) => s.pr);
  const currentUser = usePRReviewSelector((s) => s.currentUser);

  const submitReview = async (
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
  ) => {
    const state = store.getSnapshot();
    store.setSubmittingReview(true);

    let newReview: Review | null = null;

    try {
      // Redirect :commit metadata comments to a valid line in the first real
      // file, then snap every comment to a line GitHub will accept.
      const firstFile = state.files[0];
      const firstFilename = firstFile?.filename;
      const firstHunkLine = firstFile?.patch?.match(
        /^@@ -\d+(?:,\d+)? \+(\d+)/m
      )?.[1];
      const metadataLine = firstHunkLine ? parseInt(firstHunkLine, 10) : 1;
      const prepared = state.pendingComments.map((comment) =>
        prepareSubmitComment(comment, state.files, firstFilename, metadataLine)
      );
      const reviewSha =
        state.selectedCommitSha ?? state.selectedHeadSha ?? pr.head.sha;
      const submissionBody = state.reviewBody.trim()
        ? state.reviewBody
        : event === "COMMENT" || event === "REQUEST_CHANGES"
          ? " "
          : "";
      let submittedViaGraphQL = false;

      // A :commit metadata comment with no real files to redirect to cannot
      // be submitted. Fail loudly instead of sending path ":commit" to GitHub.
      const unredirectable = prepared.find(
        ({ payload }) => payload.path === ":commit"
      );
      if (unredirectable) {
        throw new Error(
          "Cannot submit commit-metadata comments when the pull request has no files"
        );
      }

      // Comments GitHub rejected at creation (lines outside the diff) are
      // still local-only. Sync them to the pending review now so submitting
      // through GraphQL doesn't drop them. Sequential: concurrent thread
      // creations can race to create duplicate pending reviews.
      let reviewNodeId = store.getPendingReviewNodeId();
      let pendingLookupFailed = false;
      let pendingReview: Awaited<ReturnType<typeof github.getPendingReview>>;
      if (reviewNodeId || state.pendingComments.length > 0) {
        try {
          pendingReview = await github.getPendingReview(owner, repo, pr.number);
        } catch {
          pendingLookupFailed = true;
          pendingReview = null;
        }
      } else {
        pendingReview = null;
      }
      if (pendingReview) {
        reviewNodeId = pendingReview.id;
        store.setPendingReviewNodeId(reviewNodeId);
      }
      if (!pendingLookupFailed && !pendingReview && reviewNodeId) {
        const existingReview = await github
          .getReview(reviewNodeId)
          .catch(() => null);
        if (!existingReview || existingReview.state === "PENDING") {
          throw new Error("Could not verify the pending review. Try again.");
        }
        newReview = submittedGraphQLReviewToReview(existingReview, currentUser);
        submittedViaGraphQL = true;
        reviewNodeId = null;
        store.setPendingReviewNodeId(null);
      }
      if (pendingLookupFailed && reviewNodeId) {
        const existingReview = await github
          .getReview(reviewNodeId)
          .catch(() => null);
        if (!existingReview || existingReview.state === "PENDING") {
          throw new Error("Could not verify the pending review. Try again.");
        }
        newReview = submittedGraphQLReviewToReview(existingReview, currentUser);
        submittedViaGraphQL = true;
        reviewNodeId = null;
        store.setPendingReviewNodeId(null);
      }
      if (pendingLookupFailed && !submittedViaGraphQL) {
        throw new Error("Could not load the pending review. Try again.");
      }
      if (pendingReview?.id !== reviewNodeId) pendingReview = null;

      const usedPendingCommentIds = new Set<number>();
      let syncFailed = false;
      for (const { comment, payload } of submittedViaGraphQL ? [] : prepared) {
        if (comment.databaseId) continue;

        const existing = pendingReview?.comments.nodes.find(
          (candidate) =>
            !usedPendingCommentIds.has(candidate.databaseId) &&
            candidate.path === payload.path &&
            candidate.line === payload.line &&
            candidate.startLine === (payload.start_line ?? null) &&
            candidate.body === payload.body &&
            (candidate.diffSide === null || candidate.diffSide === payload.side)
        );
        if (existing && reviewNodeId) {
          usedPendingCommentIds.add(existing.databaseId);
          store.updatePendingCommentWithGitHubIds(
            comment.id,
            reviewNodeId,
            existing.id,
            existing.databaseId
          );
          continue;
        }

        try {
          const result = await github.addPendingComment(
            owner,
            repo,
            pr.number,
            {
              path: payload.path,
              line: payload.line,
              body: payload.body,
              side: payload.side,
              startLine: payload.start_line,
              startSide: payload.side,
            }
          );
          store.updatePendingCommentWithGitHubIds(
            comment.id,
            result.reviewId,
            result.commentId,
            result.commentDatabaseId
          );
        } catch {
          // Remember the failure: submitting via GraphQL would silently drop
          // this comment, so the REST fallback must carry it instead.
          syncFailed = true;
        }
      }

      // Re-read: the sync loop may have created the pending review, or the
      // first mutation may have succeeded even though its response was lost.
      reviewNodeId = store.getPendingReviewNodeId();
      if (!reviewNodeId && !submittedViaGraphQL) {
        const recoveredReview = await github.getPendingReview(
          owner,
          repo,
          pr.number
        );
        if (recoveredReview) {
          reviewNodeId = recoveredReview.id;
          pendingReview = recoveredReview;
          store.setPendingReviewNodeId(reviewNodeId);
          for (const { comment, payload } of prepared) {
            if (comment.databaseId) continue;
            const existing = pendingReview.comments.nodes.find(
              (candidate) =>
                candidate.path === payload.path &&
                candidate.line === payload.line &&
                candidate.startLine === (payload.start_line ?? null) &&
                candidate.body === payload.body &&
                (candidate.diffSide === null ||
                  candidate.diffSide === payload.side)
            );
            if (!existing) {
              syncFailed = true;
              continue;
            }
            store.updatePendingCommentWithGitHubIds(
              comment.id,
              reviewNodeId,
              existing.id,
              existing.databaseId
            );
          }
        }
      }

      if (reviewNodeId && !syncFailed) {
        try {
          const submitted = await github.submitPendingReview(
            reviewNodeId,
            event,
            submissionBody
          );
          if (!submitted)
            throw new Error("GitHub did not return the submitted review");
          // Build the review from server identity so the UI can show it
          // immediately, even if the refetch below is stale.
          newReview = {
            id: submitted.databaseId,
            user: currentUser
              ? {
                  login: currentUser,
                  avatar_url: `https://avatars.githubusercontent.com/${currentUser}`,
                }
              : null,
            state:
              event === "APPROVE"
                ? "APPROVED"
                : event === "REQUEST_CHANGES"
                  ? "CHANGES_REQUESTED"
                  : "COMMENTED",
            submitted_at: submitted.submittedAt,
          } as Review;
          submittedViaGraphQL = true;
        } catch (submitError) {
          // A failed submit can still mean the review went through (e.g. a
          // retry after a partial failure). Only fall back to REST while the
          // review is genuinely still pending; otherwise REST would
          // duplicate an already-submitted review.
          const submittedReview = await github
            .getReview(reviewNodeId)
            .catch(() => null);
          if (!submittedReview) throw submitError;
          if (submittedReview.state !== "PENDING") {
            newReview = submittedGraphQLReviewToReview(
              submittedReview,
              currentUser
            );
            submittedViaGraphQL = true;
          }
        }
      }

      if (!submittedViaGraphQL) {
        // REST fallback: remove the pending draft first, then create a review
        // carrying every local comment. The local draft remains intact if
        // either request fails, so retrying cannot duplicate a remote draft.
        if (reviewNodeId) {
          await github.deletePendingReview(reviewNodeId);
          store.setPendingReviewNodeId(null);
        }
        store.setPendingComments(
          store
            .getSnapshot()
            .pendingComments.map(
              ({ nodeId: _nodeId, databaseId: _databaseId, ...comment }) =>
                comment
            )
        );
        newReview = await github.createPRReview(owner, repo, pr.number, {
          commit_id: reviewSha,
          event,
          body: submissionBody,
          comments: prepared.map(({ payload }) => ({
            path: payload.path,
            line: payload.line,
            body: payload.body,
            side: payload.side,
            start_line: payload.start_line,
            start_side: payload.start_side,
          })),
        });
      }

      github.invalidatePR(owner, repo, pr.number);
      setLastViewed(`${owner}/${repo}#${pr.number}`);
      // The GraphQL submit path can't be marked centrally — the resulting
      // activity is ours and must not notify.
      markSelfActivity(`${owner}/${repo}#${pr.number}`);

      // Refresh comments, reviews, timeline, and review threads
      const [newComments, reviews, timeline, threadsResult] = await Promise.all(
        [
          github.getPRComments(owner, repo, pr.number),
          github.getPRReviews(owner, repo, pr.number),
          github.getPRTimeline(owner, repo, pr.number),
          github
            .getReviewThreads(owner, repo, pr.number)
            .catch(() => ({ threads: [] as ReviewThread[] })),
        ]
      );

      // If the review we just submitted isn't in the re-fetched data yet
      // (eventual consistency), add it manually so it appears immediately.
      // The timeline is ascending, so a just-created review goes last.
      if (newReview?.id && !reviews.some((r) => r.id === newReview!.id)) {
        reviews.unshift(newReview);
        timeline.push({
          id: newReview.id,
          event: "reviewed",
          actor: { login: currentUser ?? "", avatar_url: "" },
          created_at: newReview.submitted_at ?? new Date().toISOString(),
        } as TimelineEvent);
      }

      // Threads can lag behind the submit too. Append a thread for any
      // submitted comment the refetch is missing so it shows under its review.
      const threads = [...threadsResult.threads];
      if (newReview?.id) {
        const knownCommentIds = new Set(
          threads.flatMap((t) => t.comments.nodes.map((c) => c.databaseId))
        );
        const author = currentUser
          ? {
              login: currentUser,
              avatarUrl: `https://avatars.githubusercontent.com/${currentUser}`,
            }
          : null;
        const timestamp = new Date().toISOString();
        // Re-read: the sync loop may have assigned GitHub IDs since the
        // snapshot taken at the start of the submission. Iterate over the
        // submitted payloads (not just comments with databaseIds) so
        // REST-fallback comments render optimistically too.
        const freshById = new Map(
          store.getSnapshot().pendingComments.map((c) => [c.id, c])
        );
        for (const { comment, payload } of prepared) {
          const fresh = freshById.get(comment.id) ?? comment;
          if (fresh.databaseId && knownCommentIds.has(fresh.databaseId)) {
            continue;
          }
          threads.push(
            pendingCommentToThread(
              fresh,
              newReview.id,
              author,
              timestamp,
              payload
            )
          );
        }
      }

      store.setComments(newComments as ReviewComment[]);
      store.setReviews(reviews);
      store.setTimeline(timeline);
      store.setReviewThreads(threads);
      store.setOverviewLoading(false);

      // If we got the review ID from REST, use it; otherwise find the latest review
      let scrollTarget: string | undefined;
      if (newReview?.id) {
        scrollTarget = `pullrequestreview-${newReview.id}`;
      } else if (reviews.length > 0) {
        // Find the most recent review (likely the one we just submitted)
        const sortedReviews = [...reviews].sort(
          (a, b) =>
            new Date(b.submitted_at ?? 0).getTime() -
            new Date(a.submitted_at ?? 0).getTime()
        );
        if (sortedReviews[0]) {
          scrollTarget = `pullrequestreview-${sortedReviews[0].id}`;
        }
      }

      store.clearReviewState();

      // Navigate to overview page and scroll to the new review
      store.selectOverview(scrollTarget);
    } catch (error) {
      console.error("Failed to submit review:", error);
      // Re-throw so the UI can surface the error to the user
      throw error;
    } finally {
      store.setSubmittingReview(false);
    }
  };

  return { submitReview };
}

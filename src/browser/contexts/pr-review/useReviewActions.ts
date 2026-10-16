import type { PullRequestFile, ReviewComment } from "@/api/types";
import { useCallback } from "react";
import {
  useGitHub,
  type Review,
  type ReviewThread,
  type GitHubStore,
} from "@/browser/contexts/github";
import {
  usePRReviewStore,
  type PRReviewStore,
  type LocalPendingComment,
} from ".";
import { setLastViewed } from "@/browser/lib/waiting-prs";
import { markSelfActivity } from "@/browser/lib/notifications";
import {
  groupPendingCommentsByTarget,
  prepareGroupComments,
  sameSubmittedComments,
  type PreparedComment,
  type SubmitCommentPayload,
} from "@/browser/lib/review-submit";
import { reviewGroupMarker } from "@/shared/review-group";

/** Represent a just-submitted comment as a thread so it renders under its
 *  review before the review-threads query catches up. Uses the submitted
 *  payload (post redirect/snap) so REST-submitted comments — which never got
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

const RECENT_REVIEW_WINDOW_MS = 90_000;

const EVENT_TO_STATE = {
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED",
} as const;

export function useReviewActions() {
  const store = usePRReviewStore();
  const github = useGitHub();
  return {
    submitReview: useCallback(
      (event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT") =>
        submitReview(store, github, event),
      [store, github]
    ),
  };
}

export async function submitReview(
  store: PRReviewStore,
  github: GitHubStore,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
) {
  const state = store.getSnapshot();
  const { owner, repo, pr, currentUser } = state;
  store.setSubmittingReview(true);
  const newReviews: Review[] = [];
  let conversationTarget: string | undefined;
  let fileCommentTarget: string | undefined;
  const author = currentUser
    ? {
        login: currentUser,
        avatarUrl: `https://avatars.githubusercontent.com/${currentUser}`,
      }
    : null;
  const publishReview = (review: Review, items: PreparedComment[]) => {
    newReviews.push(review);
    const freshById = new Map(
      store
        .getSnapshot()
        .pendingComments.map((comment) => [comment.id, comment])
    );
    store.publishSubmittedActivity({
      reviews: [review],
      threads: items.map(({ comment, payload }) =>
        pendingCommentToThread(
          freshById.get(comment.id) ?? comment,
          review.id,
          author,
          review.submitted_at ?? new Date().toISOString(),
          payload
        )
      ),
    });
  };
  const publishFileComment = (comment: ReviewComment) => {
    const thread: ReviewThread = {
      id: `submitted-thread-${comment.id}`,
      isResolved: false,
      isOutdated: false,
      resolvedBy: null,
      pullRequestReview: comment.pull_request_review_id
        ? { databaseId: comment.pull_request_review_id, author }
        : null,
      comments: {
        nodes: [
          {
            id: comment.node_id,
            databaseId: comment.id,
            body: comment.body,
            bodyHTML: comment.body_html,
            path: comment.path,
            line: comment.line ?? null,
            originalLine: comment.original_line ?? null,
            startLine: comment.start_line ?? null,
            diffHunk: comment.diff_hunk,
            originalCommit: { oid: comment.original_commit_id },
            author,
            createdAt: comment.created_at,
            updatedAt: comment.updated_at,
            replyTo: null,
          },
        ],
      },
    };
    store.publishSubmittedActivity({
      comments: [comment],
      threads: [thread],
      reviews: comment.pull_request_review_id
        ? [
            store
              .getSnapshot()
              .reviews.find(
                (review) => review.id === comment.pull_request_review_id
              ) ??
              ({
                id: comment.pull_request_review_id,
                body: "",
                state: "COMMENTED",
                user: comment.user,
                submitted_at: comment.created_at,
                commit_id: comment.commit_id,
              } as Review),
          ]
        : [],
    });
    fileCommentTarget ??= `discussion_r${comment.id}`;
  };

  try {
    const headSha = pr.head.sha;
    const submissionBody = state.reviewBody.trim()
      ? state.reviewBody
      : event === "COMMENT" || event === "REQUEST_CHANGES"
        ? " "
        : "";

    // Group comments by the commit they were made on. GitHub anchors an
    // entire review to a single commit, so a session spanning several
    // commits submits one REST review per commit; head-only sessions keep
    // the GraphQL draft flow.
    const groups = groupPendingCommentsByTarget(state.pendingComments, headSha);
    const crossCommit = groups.some(({ sha }) => sha !== headSha);

    // Fetch each target's cumulative diff (base..target) — the frame
    // GitHub validates comment lines against — then prepare payloads.
    const prKey = `${owner}/${repo}#${pr.number}`;
    const filesBySha = new Map<string, PullRequestFile[]>();
    await Promise.all(
      groups.map(async ({ sha }) => {
        filesBySha.set(
          sha,
          sha === headSha
            ? await github.getPRFiles(owner, repo, pr.number)
            : await github.getPRFilesForRange(
                owner,
                repo,
                pr.base.sha,
                sha,
                prKey
              )
        );
      })
    );
    const preparedGroups = groups.map(({ sha, comments }) => ({
      sha,
      items: prepareGroupComments(comments, filesBySha.get(sha) ?? [], {
        owner,
        repo,
        sha,
      }),
    }));
    const headItems = preparedGroups[0]?.items ?? [];

    // Comments on lines outside the diff hunks cannot be line-anchored;
    // they are submitted as standalone file-level comments instead of
    // being part of a review batch.
    const isFileLevel = (item: PreparedComment) =>
      item.payload.subject_type === "file";
    const headFileItems = headItems.filter(isFileLevel);
    const headLineItems = headItems.filter((item) => !isFileLevel(item));

    let submittedViaGraphQL = false;
    let reviewNodeId = store.getPendingReviewNodeId();

    if (crossCommit) {
      // Cross-commit comments can only go through per-commit REST reviews.
      // Drop the pending draft first — including one whose existence the
      // store lost track of — so it cannot duplicate the submission.
      const stray = await github
        .getPendingReview(owner, repo, pr.number)
        .catch(() => null);
      if (stray) {
        await github.deletePendingReview(stray.id).catch(() => {});
      }
      reviewNodeId = null;
      store.setPendingReviewNodeId(null);
      // The deleted draft takes its synced comments with it; strip stale
      // GitHub IDs so every comment re-submits via REST.
      store.setPendingComments(
        store
          .getSnapshot()
          .pendingComments.map(
            ({ nodeId: _nodeId, databaseId: _databaseId, ...comment }) =>
              comment
          )
      );
    } else {
      // Comments GitHub rejected at creation (lines outside the diff) are
      // still local-only. Sync them to the pending review now so submitting
      // through GraphQL doesn't drop them. Sequential: concurrent thread
      // creations can race to create duplicate pending reviews.
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
        const review = submittedGraphQLReviewToReview(
          existingReview,
          currentUser,
          submissionBody
        );
        publishReview(review, headLineItems);
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
        const review = submittedGraphQLReviewToReview(
          existingReview,
          currentUser,
          submissionBody
        );
        publishReview(review, headLineItems);
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
      // File-level comments (out-of-diff lines) are never part of the
      // pending review — GitHub rejects out-of-diff threads on it. They
      // stay local and are submitted as standalone comments afterwards.
      for (const { comment, payload } of submittedViaGraphQL
        ? []
        : headLineItems) {
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
              line: payload.line!,
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
          // Remember the failure: submitting via GraphQL would silently
          // drop this comment, so the REST path must carry it instead.
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
          // File-level comments cannot exist in a pending review.
          for (const { comment, payload } of headLineItems) {
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
          publishReview(
            {
              id: submitted.databaseId,
              node_id: reviewNodeId,
              body: submissionBody,
              commit_id: headSha,
              user: currentUser
                ? {
                    login: currentUser,
                    avatar_url: `https://avatars.githubusercontent.com/${currentUser}`,
                  }
                : null,
              state: EVENT_TO_STATE[event],
              submitted_at: submitted.submittedAt,
            } as Review,
            headLineItems
          );
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
            const review = submittedGraphQLReviewToReview(
              submittedReview,
              currentUser,
              submissionBody
            );
            publishReview(review, headLineItems);
            submittedViaGraphQL = true;
          }
        }
      }

      // Out-of-diff comments are not part of the pending review; they go
      // out as standalone file-level comments on the head commit. Runs for
      // every GraphQL success path (including the dedup branches above so
      // a retry still posts them). Each one is stripped locally as it
      // lands, and a failure throws before the refetch below clears
      // pending state, so nothing is lost for a retry.
      if (submittedViaGraphQL) {
        for (const item of headFileItems) {
          const created = await github.createFileLevelComment(
            owner,
            repo,
            pr.number,
            {
              commitId: headSha,
              path: item.payload.path,
              body: item.payload.body,
            }
          );
          publishFileComment(created);
          store.setPendingComments(
            store
              .getSnapshot()
              .pendingComments.filter((c) => c.id !== item.comment.id)
          );
        }
      }
    }

    if (!submittedViaGraphQL) {
      // REST path: one review per target commit. Remove any pending draft
      // first; keep local state intact if a group fails (minus groups
      // already submitted), so retrying cannot duplicate a remote review.
      if (reviewNodeId) {
        await github.deletePendingReview(reviewNodeId);
        store.setPendingReviewNodeId(null);
        store.setPendingComments(
          store
            .getSnapshot()
            .pendingComments.map(
              ({ nodeId: _nodeId, databaseId: _databaseId, ...comment }) =>
                comment
            )
        );
      }

      let freshReviews: Review[] | null = null;
      const findGuardReview = async (
        sha: string,
        items: PreparedComment[]
      ): Promise<Review | null> => {
        if (!freshReviews) {
          freshReviews = await github.getPRReviewsFresh(owner, repo, pr.number);
        }
        const candidates = freshReviews.filter(
          (r) =>
            r.user?.login === currentUser &&
            r.state === EVENT_TO_STATE[event] &&
            r.submitted_at &&
            Date.now() - Date.parse(r.submitted_at) < RECENT_REVIEW_WINDOW_MS &&
            (r.commit_id ?? "").slice(0, 7) === sha.slice(0, 7)
        );
        for (const review of candidates) {
          const submitted = await github.getReviewComments(
            owner,
            repo,
            pr.number,
            review.id
          );
          if (
            sameSubmittedComments(
              submitted,
              items.map(({ payload }) => payload)
            )
          ) {
            return review;
          }
        }
        return null;
      };

      const targets =
        preparedGroups.length > 0
          ? preparedGroups
          : [
              {
                sha:
                  state.selectedCommitSha ?? state.selectedHeadSha ?? headSha,
                items: [] as PreparedComment[],
              },
            ];

      // Multi-commit sessions embed a hidden group marker in each group's
      // first line comment so the overview can render the batch as one
      // review card. GitHub renders HTML comments as nothing; review bodies
      // stay untouched. Injecting into the payloads means the guard (which
      // strips markers) and the optimistic threads stay consistent. The
      // marker always lands on a line comment — file-level ones are not
      // part of the review batch.
      const groupToken =
        targets.length > 1 ? Math.random().toString(36).slice(2, 10) : null;
      const markedGroups: Array<{
        sha: string;
        lineItems: PreparedComment[];
        fileItems: PreparedComment[];
      }> = targets.map((group, index) => {
        const fileItems = group.items.filter(isFileLevel);
        let lineItems = group.items.filter((item) => !isFileLevel(item));
        if (groupToken && lineItems.length > 0) {
          lineItems = [
            {
              ...lineItems[0],
              payload: {
                ...lineItems[0].payload,
                body: `${reviewGroupMarker(groupToken, index, targets.length)}\n${lineItems[0].payload.body}`,
              },
            },
            ...lineItems.slice(1),
          ];
        }
        return { sha: group.sha, lineItems, fileItems };
      });

      for (const group of markedGroups) {
        const isFirstGroup = group.sha === targets[0].sha;
        const body = isFirstGroup ? submissionBody : "";
        const guardReview =
          group.lineItems.length > 0
            ? await findGuardReview(group.sha, group.lineItems)
            : null;
        try {
          if (guardReview) {
            publishReview(guardReview, group.lineItems);
          } else if (
            event === "COMMENT" &&
            group.lineItems.length === 0 &&
            !body.trim()
          ) {
            // GitHub rejects COMMENT reviews with no comments and no real
            // body; the file-level comments below carry the content.
          } else if (
            event === "COMMENT" &&
            group.lineItems.length === 0 &&
            !!body.trim()
          ) {
            // A summary with only out-of-diff comments: GitHub's own UI
            // posts the summary as a conversation comment in this case.
            const comment = await github.createPRConversationComment(
              owner,
              repo,
              pr.number,
              body
            );
            store.publishSubmittedActivity({ conversation: [comment] });
            conversationTarget ??= `issuecomment-${comment.id}`;
          } else {
            const review = await github.createPRReview(owner, repo, pr.number, {
              commit_id: group.sha,
              event,
              body,
              comments: group.lineItems.map(({ payload }) => ({
                path: payload.path,
                line: payload.line,
                body: payload.body,
                side: payload.side,
                start_line: payload.start_line,
                start_side: payload.start_side,
              })),
            });
            publishReview(review, group.lineItems);
          }
          // Out-of-diff comments become standalone file-level comments on
          // the group's commit. Each one is stripped locally as it lands so
          // a retry only re-posts the ones that failed.
          for (const item of group.fileItems) {
            const created = await github.createFileLevelComment(
              owner,
              repo,
              pr.number,
              {
                commitId: group.sha,
                path: item.payload.path,
                body: item.payload.body,
              }
            );
            publishFileComment(created);
            store.setPendingComments(
              store
                .getSnapshot()
                .pendingComments.filter((c) => c.id !== item.comment.id)
            );
          }
          // Drop the group's line comments locally so a retried submission
          // cannot send them again.
          const submittedIds = new Set(
            group.lineItems.map(({ comment }) => comment.id)
          );
          store.setPendingComments(
            store
              .getSnapshot()
              .pendingComments.filter((c) => !submittedIds.has(c.id))
          );
        } catch (error) {
          console.error("Failed to submit review group:", error);
          // Groups submitted so far persist on GitHub. Surface the error;
          // retrying skips them via the local strip above.
          if (newReviews.length === 0) throw error;
          github.invalidatePR(owner, repo, pr.number);
          throw error;
        }
      }
    }

    github.invalidatePR(owner, repo, pr.number);
    setLastViewed(`${owner}/${repo}#${pr.number}`);
    // The GraphQL submit path can't be marked centrally — the resulting
    // activity is ours and must not notify.
    markSelfActivity(`${owner}/${repo}#${pr.number}`);

    store.clearReviewState();
    store.selectOverview(
      conversationTarget ??
        (newReviews[0]?.id
          ? `pullrequestreview-${newReviews[0].id}`
          : fileCommentTarget)
    );
    // Accepted content is already visible; list failures must not turn a
    // successful submission into an error or delay navigation.
    void store
      .refreshSubmittedActivity()
      .catch((error) =>
        console.error("Failed to refresh submitted activity:", error)
      );
  } catch (error) {
    console.error("Failed to submit review:", error);
    // Re-throw so the UI can surface the error to the user
    throw error;
  } finally {
    store.setSubmittingReview(false);
  }
}

function submittedGraphQLReviewToReview(
  submitted: {
    databaseId: number;
    state?: string;
    submittedAt: string | null;
    body?: string;
  },
  currentUser: string | null,
  body: string
): Review {
  return {
    id: submitted.databaseId,
    body: submitted.body ?? body,
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

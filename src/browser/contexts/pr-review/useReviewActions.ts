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
import {
  groupPendingCommentsByTarget,
  pendingTargetSha,
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
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const pr = usePRReviewSelector((s) => s.pr);
  const currentUser = usePRReviewSelector((s) => s.currentUser);

  const submitReview = async (
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
  ) => {
    const state = store.getSnapshot();
    store.setSubmittingReview(true);
    const newReviews: Review[] = [];

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
      const groups = groupPendingCommentsByTarget(
        state.pendingComments,
        headSha
      );
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
        items: prepareGroupComments(comments, filesBySha.get(sha) ?? []),
      }));
      const headItems = preparedGroups[0]?.items ?? [];

      // Review id (REST database id) per target commit, so optimistic
      // threads can reference the review they were submitted under.
      const shaToReviewId = new Map<string, number>();
      // Marked payload per comment id (multi-commit sessions mark the first
      // comment of each group) — used by the optimistic-thread pass.
      const markedPayloads = new Map<string, SubmitCommentPayload>();
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
            pendingReview = await github.getPendingReview(
              owner,
              repo,
              pr.number
            );
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
            currentUser
          );
          shaToReviewId.set(headSha, review.id);
          newReviews.push(review);
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
            currentUser
          );
          shaToReviewId.set(headSha, review.id);
          newReviews.push(review);
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
        for (const { comment, payload } of submittedViaGraphQL
          ? []
          : headItems) {
          if (comment.databaseId) continue;

          const existing = pendingReview?.comments.nodes.find(
            (candidate) =>
              !usedPendingCommentIds.has(candidate.databaseId) &&
              candidate.path === payload.path &&
              candidate.line === payload.line &&
              candidate.startLine === (payload.start_line ?? null) &&
              candidate.body === payload.body &&
              (candidate.diffSide === null ||
                candidate.diffSide === payload.side)
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
            for (const { comment, payload } of headItems) {
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
            shaToReviewId.set(headSha, submitted.databaseId);
            newReviews.push({
              id: submitted.databaseId,
              user: currentUser
                ? {
                    login: currentUser,
                    avatar_url: `https://avatars.githubusercontent.com/${currentUser}`,
                  }
                : null,
              state: EVENT_TO_STATE[event],
              submitted_at: submitted.submittedAt,
            } as Review);
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
                currentUser
              );
              shaToReviewId.set(headSha, review.id);
              newReviews.push(review);
              submittedViaGraphQL = true;
            }
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
            freshReviews = await github.getPRReviewsFresh(
              owner,
              repo,
              pr.number
            );
          }
          const candidates = freshReviews.filter(
            (r) =>
              r.user?.login === currentUser &&
              r.state === EVENT_TO_STATE[event] &&
              r.submitted_at &&
              Date.now() - Date.parse(r.submitted_at) <
                RECENT_REVIEW_WINDOW_MS &&
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
        // first comment so the overview can render the batch as one review
        // card. GitHub renders HTML comments as nothing; review bodies stay
        // untouched. Injecting into the payloads means the guard (which
        // strips markers) and the optimistic threads stay consistent.
        const groupToken =
          targets.length > 1 ? Math.random().toString(36).slice(2, 10) : null;
        const markedGroups: Array<{ sha: string; items: PreparedComment[] }> =
          groupToken
            ? targets.map((group, index) => ({
                ...group,
                items: group.items.map((item, itemIndex) =>
                  itemIndex === 0
                    ? {
                        ...item,
                        payload: {
                          ...item.payload,
                          body: `${reviewGroupMarker(groupToken, index, targets.length)}\n${item.payload.body}`,
                        },
                      }
                    : item
                ),
              }))
            : targets;

        if (groupToken) {
          for (const group of markedGroups) {
            const first = group.items[0];
            if (first) markedPayloads.set(first.comment.id, first.payload);
          }
        }

        for (const group of markedGroups) {
          const guardReview = await findGuardReview(group.sha, group.items);
          if (guardReview) {
            shaToReviewId.set(group.sha, guardReview.id);
            newReviews.push(guardReview);
            continue;
          }
          try {
            const review = await github.createPRReview(owner, repo, pr.number, {
              commit_id: group.sha,
              event,
              body: group.sha === targets[0].sha ? submissionBody : "",
              comments: group.items.map(({ payload }) => ({
                path: payload.path,
                line: payload.line,
                body: payload.body,
                side: payload.side,
                start_line: payload.start_line,
                start_side: payload.start_side,
              })),
            });
            shaToReviewId.set(group.sha, review.id);
            newReviews.push(review);
            // Drop the group's comments locally so a retried submission
            // cannot send them again.
            const submittedIds = new Set(
              group.items.map(({ comment }) => comment.id)
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

      // If a review we just submitted isn't in the re-fetched data yet
      // (eventual consistency), add it manually so it appears immediately.
      // The timeline is ascending, so just-created reviews go last. The two
      // endpoints lag independently: GitHub's timeline can already carry the
      // event while the reviews list doesn't (and vice versa), so check each
      // separately — otherwise the review renders twice until the next
      // periodic refresh clears the optimistic copy.
      for (const review of newReviews) {
        if (!review.id) continue;
        if (!reviews.some((r) => r.id === review.id)) {
          reviews.unshift(review);
        }
        const timelineHasEvent = timeline.some(
          (t) =>
            "event" in t &&
            t.event === "reviewed" &&
            "id" in t &&
            t.id === review.id
        );
        if (timelineHasEvent) continue;
        timeline.push({
          id: review.id,
          event: "reviewed",
          actor: { login: currentUser ?? "", avatar_url: "" },
          created_at: review.submitted_at ?? new Date().toISOString(),
        } as TimelineEvent);
      }

      // Threads can lag behind the submit too. Append a thread for any
      // submitted comment the refetch is missing so it shows under its review.
      const threads = [...threadsResult.threads];
      if (newReviews.length > 0) {
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
        // REST-submitted comments render optimistically too.
        const freshById = new Map(
          store.getSnapshot().pendingComments.map((c) => [c.id, c])
        );
        for (const { comment, payload } of preparedGroups.flatMap(
          (g) => g.items
        )) {
          const fresh = freshById.get(comment.id) ?? comment;
          if (fresh.databaseId && knownCommentIds.has(fresh.databaseId)) {
            continue;
          }
          const reviewId = shaToReviewId.get(pendingTargetSha(fresh, headSha));
          if (!reviewId) continue;
          threads.push(
            pendingCommentToThread(
              fresh,
              reviewId,
              author,
              timestamp,
              markedPayloads.get(comment.id) ?? payload
            )
          );
        }
      }

      store.setComments(newComments as ReviewComment[]);
      store.setReviews(reviews);
      store.setTimeline(timeline);
      store.setReviewThreads(threads);
      store.setOverviewLoading(false);

      let scrollTarget: string | undefined;
      if (newReviews[0]?.id) {
        scrollTarget = `pullrequestreview-${newReviews[0].id}`;
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

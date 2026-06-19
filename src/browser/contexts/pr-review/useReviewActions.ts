import type { ReviewComment } from "@/api/types";
import {
  useGitHub,
  type Review,
  type TimelineEvent,
} from "@/browser/contexts/github";
import { usePRReviewStore, usePRReviewSelector } from ".";

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
      // Get the pending review node ID (from GraphQL)
      const reviewNodeId = store.getPendingReviewNodeId();

      if (reviewNodeId) {
        // Submit via GraphQL - we'll find the review ID after refreshing
        await github.submitPendingReview(reviewNodeId, event, state.reviewBody);
      } else if (state.pendingComments.length > 0) {
        // Fallback: create a new review with all comments via REST
        // Redirect :commit metadata comments to the first real file
        const firstFile = state.files[0]?.filename;
        newReview = await github.createPRReview(owner, repo, pr.number, {
          commit_id: pr.head.sha,
          event,
          body: state.reviewBody,
          comments: state.pendingComments.map(
            ({ path, line, body, side, start_line }) => {
              const isMetadata = path === ":commit" && firstFile;
              return {
                path: isMetadata ? firstFile : path,
                line: isMetadata ? 1 : line,
                body,
                side: side as "LEFT" | "RIGHT",
                start_line: isMetadata ? undefined : start_line,
              };
            }
          ),
        });
      } else {
        // Just submitting a review with no comments (APPROVE, etc)
        newReview = await github.createPRReview(owner, repo, pr.number, {
          commit_id: pr.head.sha,
          event,
          body: state.reviewBody,
          comments: [],
        });
      }

      // Invalidate timeline cache so we get fresh data
      github.invalidateCache(`pr:${owner}/${repo}/${pr.number}`);

      // Refresh comments, reviews, and timeline
      const [newComments, reviews, timeline] = await Promise.all([
        github.getPRComments(owner, repo, pr.number),
        github.getPRReviews(owner, repo, pr.number),
        github.getPRTimeline(owner, repo, pr.number),
      ]);

      // If the review we just submitted isn't in the re-fetched data yet
      // (eventual consistency), add it manually so it appears immediately.
      const addReviewToArray = (review: Review) => {
        // Remove any stale review by the same user so the new one takes effect
        const existingIdx = reviews.findIndex(
          (r) => r.user?.login === review.user?.login
        );
        if (existingIdx !== -1) reviews.splice(existingIdx, 1);
        reviews.unshift(review);
      };

      if (newReview?.id && !reviews.some((r) => r.id === newReview!.id)) {
        addReviewToArray(newReview);
        timeline.unshift({
          id: newReview.id,
          event: "reviewed",
          actor: { login: currentUser ?? "", avatar_url: "" },
          created_at: new Date().toISOString(),
        } as TimelineEvent);
      } else if (!newReview && currentUser) {
        // GraphQL path: submitPendingReview returns void, so newReview is null.
        // Construct a synthetic review so the UI updates immediately.
        const submittedAt = new Date().toISOString();
        const syntheticReview = {
          id: Date.now(),
          user: {
            login: currentUser,
            avatar_url: `https://github.com/${currentUser}.png`,
          },
          state:
            event === "APPROVE"
              ? "APPROVED"
              : event === "REQUEST_CHANGES"
                ? "CHANGES_REQUESTED"
                : "COMMENTED",
          submitted_at: submittedAt,
        } as Review;
        if (!reviews.some((r) => r.user?.login === currentUser)) {
          addReviewToArray(syntheticReview);
          timeline.unshift({
            id: syntheticReview.id,
            event: "reviewed",
            actor: {
              login: currentUser,
              avatar_url: `https://github.com/${currentUser}.png`,
            },
            created_at: submittedAt,
          } as TimelineEvent);
        }
      }

      store.setComments(newComments as ReviewComment[]);
      store.setReviews(reviews);
      store.setTimeline(timeline);

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
    } finally {
      store.setSubmittingReview(false);
    }
  };

  return { submitReview };
}

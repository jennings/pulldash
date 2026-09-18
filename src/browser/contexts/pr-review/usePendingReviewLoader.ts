import { useEffect } from "react";
import { useGitHubStore, useGitHubSelector } from "@/browser/contexts/github";
import {
  usePRReviewStore,
  usePRReviewSelector,
  type LocalPendingComment,
} from ".";

export function usePendingReviewLoader() {
  const store = usePRReviewStore();
  const github = useGitHubStore();
  const ready = useGitHubSelector((s) => s.ready);
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const pr = usePRReviewSelector((s) => s.pr);

  useEffect(() => {
    if (!ready) return;

    const fetchPendingReview = async () => {
      try {
        const result = await github.getPendingReview(owner, repo, pr.number);
        if (!result) return;

        // Store the review node ID for submission
        store.setPendingReviewNodeId(result.id);

        // Convert to local comments, preserving the diff side GitHub
        // reports so LEFT comments render under the old row after reload.
        const localComments: LocalPendingComment[] = result.comments.nodes.map(
          (c) => ({
            id: `github-${c.databaseId}`,
            nodeId: c.id,
            databaseId: c.databaseId,
            path: c.path,
            line: c.line,
            start_line: c.startLine || undefined,
            body: c.body,
            side:
              c.diffSide === "LEFT" ? ("LEFT" as const) : ("RIGHT" as const),
          })
        );

        // Comments GitHub refused to anchor (e.g. lines outside the diff) are
        // local-only; keep them so they are not lost when a pending review
        // exists for the synced ones.
        const localOnly = store
          .getSnapshot()
          .pendingComments.filter((c) => !c.nodeId);

        store.setPendingComments([...localComments, ...localOnly]);
      } catch (error) {
        console.error("Failed to fetch pending review:", error);
      }
    };

    fetchPendingReview();
  }, [github, owner, repo, pr.number, store]);
}

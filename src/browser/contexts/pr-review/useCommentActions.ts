import type { ReviewComment } from "@/api/types";
import { useGitHub } from "@/browser/contexts/github";
import {
  usePRReviewStore,
  usePRReviewSelector,
  type LocalPendingComment,
} from ".";
import { getCommitFieldLabel } from "./useCurrentDiff";
import { withReviewGroupMarker } from "@/shared/review-group";
import { resolveCommentPosition } from "@/browser/lib/reviews";

export function useCommentActions() {
  const store = usePRReviewStore();
  const github = useGitHub();
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const pr = usePRReviewSelector((s) => s.pr);

  const addPendingComment = async (
    line: number,
    body: string,
    startLine?: number
  ) => {
    const state = store.getSnapshot();
    if (!state.selectedFile) return;

    // For :commit synthetic file, prefix the body with a marker so we
    // can route the comment back on reload. The local pending comment
    // stays on ":commit" with the original line; only the GitHub sync
    // redirects to the first real file at a line in the diff.
    let githubPath = state.selectedFile;
    let githubLine = line;
    let finalBody = body;
    let githubStartLine: number | undefined = startLine;
    const commentSide: "LEFT" | "RIGHT" =
      state.commentingOnLine?.side === "old" ? "LEFT" : "RIGHT";
    let githubSide: "LEFT" | "RIGHT" = commentSide;

    if (state.selectedFile === ":commit" && state.files.length > 0) {
      const fullSha = state.selectedCommitSha ?? "";
      const shortSha = fullSha.slice(0, 7);
      const firstFile = state.files[0];
      githubPath = firstFile.filename;
      // Use the first hunk's start line so the comment targets a line that
      // actually exists in the diff. Fall back to line 1 if no patch data.
      const patchStart = firstFile.patch?.match(/^@@ -\d+(?:,\d+)? \+(\d+)/m);
      githubLine = patchStart ? parseInt(patchStart[1], 10) : 1;
      githubStartLine = undefined;
      githubSide = "RIGHT";
      const commit = state.commits.find((c) => c.sha === fullSha);
      const label = commit ? getCommitFieldLabel(line, commit) : `line ${line}`;
      const marker = `<!-- pulldash:commit-metadata sha=${fullSha} line=${line} label=${label} -->`;
      finalBody =
        `_This comment was made on the commit metadata for commit ${shortSha}, on the ${label} line._\n\n` +
        `${marker}\n\n` +
        body;
    }

    // Create a local comment first for immediate UI feedback
    // Local path/line stay on ":commit" so it appears at the right place
    const localId = `pending-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    // Record the diff the comment was made on so submission can anchor it
    // to that commit (undefined = PR head).
    const targetSha =
      state.selectedCommitSha ?? state.selectedHeadSha ?? undefined;
    const newComment: LocalPendingComment = {
      id: localId,
      path: state.selectedFile,
      line,
      start_line: startLine,
      body: finalBody,
      side: commentSide,
      targetSha,
    };

    store.addPendingComment(newComment);

    // Sync to GitHub via GraphQL - this creates/adds to the pending review.
    // For :commit comments, the GitHub comment goes to the first real file.
    // Comments made on a non-head diff skip the sync: GitHub's thread
    // mutation can only anchor to the head diff, so they stay local until
    // submission groups them by commit.
    // Out-of-diff lines (context outside the hunks) are skipped too: GitHub
    // rejects out-of-diff threads on the pending review, and they are
    // submitted as standalone file-level comments instead.
    const patch =
      state.files.find((f) => f.filename === state.selectedFile)?.patch ?? null;
    const outOfDiff =
      !!patch &&
      resolveCommentPosition(
        { line, start_line: startLine, side: commentSide },
        patch
      ).adjusted;
    if (!outOfDiff && (!targetSha || targetSha === pr.head.sha)) {
      try {
        const result = await github.addPendingComment(owner, repo, pr.number, {
          path: githubPath,
          line: githubLine,
          body: finalBody,
          side: githubSide,
          startLine: githubStartLine,
          startSide: githubSide,
        });
        // Update the local comment with GitHub IDs
        store.updatePendingCommentWithGitHubIds(
          localId,
          result.reviewId,
          result.commentId,
          result.commentDatabaseId
        );
      } catch (error) {
        console.error("Failed to sync pending comment to GitHub:", error);
      }
    }
  };

  const removePendingComment = async (id: string) => {
    const state = store.getSnapshot();
    const comment = state.pendingComments.find((c) => c.id === id);

    // Remove locally first
    store.removePendingComment(id);

    // Delete from GitHub via GraphQL if it was synced
    if (comment?.nodeId) {
      try {
        await github.deletePendingComment(comment.nodeId);
      } catch (error) {
        console.error("Failed to delete comment from GitHub:", error);
      }
    }
  };

  const updatePendingComment = async (id: string, newBody: string) => {
    const state = store.getSnapshot();
    const comment = state.pendingComments.find((c) => c.id === id);

    // Update locally first
    store.updatePendingCommentBody(id, newBody);

    // Update on GitHub via GraphQL if it was synced
    if (comment?.nodeId) {
      try {
        await github.updatePendingComment(comment.nodeId, newBody);
      } catch (error) {
        console.error("Failed to update comment on GitHub:", error);
      }
    }
  };

  const updateComment = async (commentId: number, newBody: string) => {
    try {
      // Re-attach the hidden review-group marker that editing strips.
      const original = store
        .getSnapshot()
        .comments.find((c) => c.id === commentId);
      const updatedComment = await github.updateComment(
        owner,
        repo,
        commentId,
        original ? withReviewGroupMarker(original.body, newBody) : newBody
      );
      store.updateComment(commentId, updatedComment as ReviewComment);
    } catch (error) {
      console.error("Failed to update comment:", error);
    }
  };

  const deleteComment = async (commentId: number) => {
    try {
      await github.deleteComment(owner, repo, commentId);
      store.deleteComment(commentId);
    } catch (error) {
      console.error("Failed to delete comment:", error);
    }
  };

  const replyToComment = async (commentId: number, body: string) => {
    try {
      const newComment = await github.createPRComment(
        owner,
        repo,
        pr.number,
        body,
        {
          reply_to_id: commentId,
        }
      );
      store.addReply(newComment as ReviewComment);
    } catch (error) {
      console.error("Failed to reply to comment:", error);
    }
  };

  return {
    addPendingComment,
    removePendingComment,
    updatePendingComment,
    updateComment,
    deleteComment,
    replyToComment,
  };
}

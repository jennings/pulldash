import type { ReviewComment } from "@/api/types";
import { useGitHub } from "@/browser/contexts/github";
import {
  usePRReviewStore,
  usePRReviewSelector,
  type LocalPendingComment,
} from ".";
import { getCommitFieldLabel } from "./useCurrentDiff";

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
    // redirects to the first real file at line 1.
    let githubPath = state.selectedFile;
    let githubLine = line;
    let finalBody = body;
    let githubStartLine: number | undefined = startLine;

    if (state.selectedFile === ":commit" && state.files.length > 0) {
      const fullSha = state.selectedCommitSha ?? "";
      const shortSha = fullSha.slice(0, 7);
      githubPath = state.files[0].filename;
      githubLine = 1;
      githubStartLine = undefined;
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
    const newComment: LocalPendingComment = {
      id: localId,
      path: state.selectedFile,
      line,
      start_line: startLine,
      body: finalBody,
      side: "RIGHT",
    };

    store.addPendingComment(newComment);

    // Sync to GitHub via GraphQL - this creates/adds to the pending review
    // For :commit comments, the GitHub comment goes to the first real file
    try {
      const result = await github.addPendingComment(owner, repo, pr.number, {
        path: githubPath,
        line: githubLine,
        body: finalBody,
        startLine: githubStartLine,
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
      const updatedComment = await github.updateComment(
        owner,
        repo,
        commentId,
        newBody
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

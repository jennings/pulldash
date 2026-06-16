import { useEffect, useMemo } from "react";
import {
  usePRReviewSelector,
  usePRReviewStore,
  equivalentShortShas,
  parseChangeId,
  type LocalPendingComment,
} from ".";
import {
  isMetadataComment,
  parseCommitMetadataMarker,
} from "@/shared/commit-metadata";

const EMPTY_PENDING_COMMENTS: LocalPendingComment[] = [];

/** Get pending comments for current file */
export function useCurrentFilePendingComments(): LocalPendingComment[] {
  const store = usePRReviewStore();
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const selectedCommitSha = usePRReviewSelector((s) => s.selectedCommitSha);
  const commits = usePRReviewSelector((s) => s.commits);
  const commitsByVersion = usePRReviewSelector((s) => s.commitsByVersion);
  const commitVersionHistory = usePRReviewSelector(
    (s) => s.commitVersionHistory
  );
  const commitChangeIds = usePRReviewSelector((s) => s.commitChangeIds);
  const pendingComments = usePRReviewSelector((s) => s.pendingComments);

  // Lazy-fetch the jj change-id from the raw git commit header when the
  // commit has no Change-Id trailer in its message body.
  useEffect(() => {
    if (!selectedCommitSha) return;
    const commit = commits.find((c) => c.sha === selectedCommitSha);
    if (!commit) return;
    if (
      parseChangeId(commit.commit.message) ||
      commitChangeIds[selectedCommitSha]
    )
      return;
    store.getCommitChangeId(commit);
  }, [selectedCommitSha, commits, commitChangeIds, store]);

  // After the current commit's change-id is resolved, populate remaining
  // commits' change-ids (delegates to store to avoid duplicate work).
  useEffect(() => {
    if (!commitChangeIds[selectedCommitSha || ""]) return;
    store.loadCommitChangeIds();
  }, [commitChangeIds, selectedCommitSha, store]);

  const validShas = useMemo(() => {
    if (!selectedCommitSha) return null;
    return new Set(
      equivalentShortShas(
        selectedCommitSha,
        commits,
        commitsByVersion,
        commitVersionHistory,
        commitChangeIds
      )
    );
  }, [
    selectedCommitSha,
    commits,
    commitsByVersion,
    commitVersionHistory,
    commitChangeIds,
  ]);
  return useMemo(() => {
    if (!selectedFile) return EMPTY_PENDING_COMMENTS;
    if (selectedFile === ":commit") {
      return pendingComments.filter((c) => {
        if (c.path !== ":commit") return false;
        if (!isMetadataComment(c.body)) return false;
        if (!validShas) return false;
        const info = parseCommitMetadataMarker(c.body);
        return !!info && validShas.has(info.sha);
      });
    }
    return pendingComments.filter((c) => c.path === selectedFile);
  }, [selectedFile, validShas, pendingComments]);
}

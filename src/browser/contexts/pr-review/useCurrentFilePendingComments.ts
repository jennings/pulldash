import { useMemo } from "react";
import {
  usePRReviewSelector,
  equivalentShortShas,
  type LocalPendingComment,
} from ".";
import {
  COMMIT_METADATA_MARKER,
  parseCommitMetadataMarker,
} from "@/shared/commit-metadata";

const EMPTY_PENDING_COMMENTS: LocalPendingComment[] = [];

/** Get pending comments for current file */
export function useCurrentFilePendingComments(): LocalPendingComment[] {
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const selectedCommitSha = usePRReviewSelector((s) => s.selectedCommitSha);
  const commits = usePRReviewSelector((s) => s.commits);
  const commitsByVersion = usePRReviewSelector((s) => s.commitsByVersion);
  const commitVersionHistory = usePRReviewSelector(
    (s) => s.commitVersionHistory
  );
  const pendingComments = usePRReviewSelector((s) => s.pendingComments);
  const validShas = useMemo(() => {
    if (!selectedCommitSha) return null;
    return new Set(
      equivalentShortShas(
        selectedCommitSha,
        commits,
        commitsByVersion,
        commitVersionHistory
      )
    );
  }, [selectedCommitSha, commits, commitsByVersion, commitVersionHistory]);
  return useMemo(() => {
    if (!selectedFile) return EMPTY_PENDING_COMMENTS;
    if (selectedFile === ":commit") {
      return pendingComments.filter((c) => {
        if (c.path !== ":commit") return false;
        if (!c.body?.includes(COMMIT_METADATA_MARKER)) return false;
        if (!validShas) return false;
        const info = parseCommitMetadataMarker(c.body);
        return !!info && validShas.has(info.sha);
      });
    }
    return pendingComments.filter((c) => c.path === selectedFile);
  }, [selectedFile, validShas, pendingComments]);
}

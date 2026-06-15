import { useMemo } from "react";
import type { ReviewComment } from "@/api/types";
import { usePRReviewSelector, equivalentShortShas } from ".";
import {
  COMMIT_METADATA_MARKER,
  parseCommitMetadataMarker,
} from "@/shared/commit-metadata";

const EMPTY_COMMENTS: ReviewComment[] = [];

/** Get comments for current file */
export function useCurrentFileComments(): ReviewComment[] {
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const selectedCommitSha = usePRReviewSelector((s) => s.selectedCommitSha);
  const commits = usePRReviewSelector((s) => s.commits);
  const commitsByVersion = usePRReviewSelector((s) => s.commitsByVersion);
  const commitVersionHistory = usePRReviewSelector(
    (s) => s.commitVersionHistory
  );
  const comments = usePRReviewSelector((s) => s.comments);
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
    if (!selectedFile) return EMPTY_COMMENTS;
    if (selectedFile === ":commit") {
      return comments.filter((c) => {
        if (c.path !== ":commit") return false;
        if (!c.body?.includes(COMMIT_METADATA_MARKER)) return false;
        if (!validShas) return false;
        const info = parseCommitMetadataMarker(c.body);
        return !!info && validShas.has(info.sha);
      });
    }
    return comments.filter((c) => c.path === selectedFile);
  }, [selectedFile, validShas, comments]);
}

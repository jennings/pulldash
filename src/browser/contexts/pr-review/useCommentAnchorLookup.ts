import { useMemo } from "react";
import { usePRReviewSelector } from ".";

export function useCommentAnchorLookup(): Set<number> | null {
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const commentAnchorLookup = usePRReviewSelector((s) => s.commentAnchorLookup);

  return useMemo(() => {
    if (!selectedFile) return null;
    return commentAnchorLookup[selectedFile] ?? null;
  }, [selectedFile, commentAnchorLookup]);
}

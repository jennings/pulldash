import { useMemo } from "react";
import type { PullRequestFile } from "@/api/types";
import { usePRReviewSelector } from ".";

const COMMIT_FILE = ":commit";

/** Get the current file object */
export function useCurrentFile(): PullRequestFile | null {
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const files = usePRReviewSelector((s) => s.files);
  return useMemo(() => {
    if (!selectedFile) return null;
    if (selectedFile === COMMIT_FILE) {
      return {
        filename: ":commit",
        sha: null,
        status: "modified",
        additions: 0,
        deletions: 0,
        changes: 0,
      } as PullRequestFile;
    }
    return files.find((f) => f.filename === selectedFile) ?? null;
  }, [selectedFile, files]);
}

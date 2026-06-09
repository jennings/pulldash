import { useMemo } from "react";
import { usePRReviewSelector, type ParsedDiff } from ".";

/** Get the current file's diff, using interdiff results when interdiff mode is active */
export function useCurrentDiff(): ParsedDiff | null {
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const loadedDiffs = usePRReviewSelector((s) => s.loadedDiffs);
  const interdiffEnabled = usePRReviewSelector((s) => s.interdiffEnabled);
  const interdiffLoadedDiffs = usePRReviewSelector(
    (s) => s.interdiffLoadedDiffs
  );
  return useMemo(() => {
    if (!selectedFile) return null;
    if (interdiffEnabled) {
      return interdiffLoadedDiffs[selectedFile] ?? null;
    }
    return loadedDiffs[selectedFile] ?? null;
  }, [selectedFile, loadedDiffs, interdiffEnabled, interdiffLoadedDiffs]);
}

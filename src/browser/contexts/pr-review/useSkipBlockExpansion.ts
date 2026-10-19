import { useCallback } from "react";
import { useGitHub } from "@/browser/contexts/github";
import { diffService } from "@/browser/lib/diff";
import {
  usePRReviewStore,
  usePRReviewSelector,
  getLoadedFileDiff,
  type DiffLine,
} from ".";
import { expandComparisonContext } from "@/browser/lib/diff-expansion";

export function useSkipBlockExpansion() {
  const store = usePRReviewStore();
  const github = useGitHub();
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const pr = usePRReviewSelector((s) => s.pr);
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const expandedSkipBlocks = usePRReviewSelector((s) => s.expandedSkipBlocks);
  const expandingSkipBlocks = usePRReviewSelector((s) => s.expandingSkipBlocks);

  const expandSkipBlock = useCallback(
    async (
      skipIndex: number,
      startLine: number,
      oldStartLine: number,
      count: number,
      options?: { focusFirstLine?: boolean }
    ) => {
      if (!selectedFile) return;

      const key = store.getSkipBlockKey(selectedFile, skipIndex);
      const version = store.getSelectionVersion();
      const state = store.getSnapshot();
      const diff = getLoadedFileDiff(state, selectedFile);

      // Already expanded or expanding
      if (expandedSkipBlocks[key] || expandingSkipBlocks.has(key)) return;

      store.setSkipBlockExpanding(key, true);

      try {
        const getContent = (path: string, sha: string) =>
          github.getFileContent(
            owner,
            repo,
            path,
            sha,
            `${owner}/${repo}/${pr.number}`
          );
        const block = diff?.hunks.filter((h) => h.type === "skip")[skipIndex];
        const expandedLines =
          diff?.sources && block
            ? await expandComparisonContext(
                {
                  ...block,
                  oldStart: block.oldStart ?? oldStartLine,
                  newStart: block.newStart ?? startLine,
                },
                diff.sources,
                getContent,
                diffService.compareContents.bind(diffService),
                diffService.highlightLines.bind(diffService)
              )
            : await diffService.highlightLines(
                await getContent(
                  selectedFile,
                  state.selectedCommitSha ??
                    state.selectedHeadSha ??
                    pr.head.sha
                ),
                selectedFile,
                startLine,
                oldStartLine,
                count
              );
        if (version !== store.getSelectionVersion()) return;

        store.setExpandedSkipBlock(key, expandedLines);

        // Focus the first expanded line so user can continue with keyboard.
        // Skipped for programmatic expansions (e.g. revealing an
        // out-of-diff comment) so the original target keeps focus.
        if ((options?.focusFirstLine ?? true) && expandedLines.length > 0) {
          const firstLine = expandedLines[0];
          const firstLineNum =
            firstLine.newLineNumber || firstLine.oldLineNumber;
          if (firstLineNum) {
            store.setFocusedLine(
              firstLineNum,
              firstLine.newLineNumber != null ? "new" : "old"
            );
          }
        }
      } catch (error) {
        console.error("Failed to expand skip block:", error);
      } finally {
        if (version === store.getSelectionVersion())
          store.setSkipBlockExpanding(key, false);
      }
    },
    [
      store,
      owner,
      repo,
      pr.head.sha,
      selectedFile,
      expandedSkipBlocks,
      expandingSkipBlocks,
    ]
  );

  // Create a getExpandedLines function that uses the subscribed state directly
  const getExpandedLines = useCallback(
    (skipIndex: number): DiffLine[] | null => {
      if (!selectedFile) return null;
      const key = `${selectedFile}:${skipIndex}`;
      return expandedSkipBlocks[key] ?? null;
    },
    [selectedFile, expandedSkipBlocks]
  );

  const isExpanding = useCallback(
    (skipIndex: number): boolean => {
      if (!selectedFile) return false;
      const key = `${selectedFile}:${skipIndex}`;
      return expandingSkipBlocks.has(key);
    },
    [selectedFile, expandingSkipBlocks]
  );

  return { expandSkipBlock, isExpanding, getExpandedLines };
}

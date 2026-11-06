import { memo, useMemo, type CSSProperties } from "react";
import { FileDiff } from "@pierre/diffs/react";
import { fileDiffFromPatch, windowPatchAroundLines } from "../lib/file-diff";
import { useSnippetDiffOptions } from "../lib/pierre";

// Snippets sit inside cards and read at the surrounding UI's size, a notch
// below the diff panel's code.
const SNIPPET_STYLE = {
  "--diffs-font-size": "0.75rem",
} as CSSProperties;

/**
 * Read-only unified diff of a single hunk, e.g. the code a review thread is
 * attached to. `line`/`startLine` narrow the hunk to the lines around the
 * comment. They are primitives so `memo` can skip unchanged renders.
 */
export const DiffSnippet = memo(function DiffSnippet({
  patch,
  filename,
  line = null,
  startLine = null,
}: {
  patch: string;
  filename: string;
  line?: number | null;
  startLine?: number | null;
}) {
  const options = useSnippetDiffOptions();
  // Pierre compares the diff by reference, so build it once per input.
  const fileDiff = useMemo(() => {
    const windowed = windowPatchAroundLines(patch, { line, startLine });
    return fileDiffFromPatch({
      patch: windowed,
      filename,
      cacheKey: `diff-snippet:${filename}\n${windowed}`,
    });
  }, [patch, filename, line, startLine]);

  if (fileDiff.hunks.length === 0) return null;
  return (
    <div className="border-b border-border">
      <FileDiff fileDiff={fileDiff} options={options} style={SNIPPET_STYLE} />
    </div>
  );
});

import type { ParsedDiff } from "./diff-parser";
import { commitShasMatch } from "./comment-anchor";

export function comparisonCommentTarget(
  diff: ParsedDiff | null,
  side: "old" | "new"
) {
  const source = diff?.sources?.[side];
  return (
    source && {
      path: source.path,
      targetSha: source.sha,
      side: "RIGHT" as const,
    }
  );
}

export function comparisonCommentSide(
  diff: ParsedDiff,
  path: string,
  sha: string | undefined | null,
  side: string | undefined | null
): "LEFT" | "RIGHT" | null {
  if (!diff.sources || side === "LEFT") return null;
  for (const [key, displayed] of [
    ["new", "RIGHT"],
    ["old", "LEFT"],
  ] as const) {
    const source = diff.sources[key];
    if (path === source.path && commitShasMatch(sha, source.sha))
      return displayed;
  }
  return null;
}

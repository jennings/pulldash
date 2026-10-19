import type { PullRequestFile } from "@/api/types";

export interface ComparisonFile {
  filename: string;
  previous?: PullRequestFile;
  current?: PullRequestFile;
}

export function pairComparisonFiles(
  previous: PullRequestFile[],
  current: PullRequestFile[]
): ComparisonFile[] {
  const remaining = new Set(previous);
  const byName = new Map(previous.map((file) => [file.filename, file]));
  const origin = (file: PullRequestFile) =>
    file.status === "renamed"
      ? (file.previous_filename ?? file.filename)
      : file.filename;
  const byOrigin = new Map(
    previous
      .filter((file) => file.status !== "copied")
      .map((file) => [origin(file), file])
  );
  // Reserve exact matches before considering rename origins.
  const matched = current.map((file) => byName.get(file.filename));
  for (const file of matched) if (file) remaining.delete(file);
  const pairs = current.map((file, index) => {
    let old = matched[index];
    if (!old && file.status !== "copied") {
      const candidate = byOrigin.get(origin(file));
      if (candidate && remaining.delete(candidate)) old = candidate;
    }
    return { filename: file.filename, previous: old, current: file };
  });
  return [
    ...pairs,
    ...Array.from(remaining, (file) => ({
      filename: file.filename,
      previous: file,
      current: undefined,
    })),
  ];
}

export function comparisonFileList(pairs: ComparisonFile[]): PullRequestFile[] {
  return pairs.map(
    ({ previous, current }) =>
      current ?? {
        ...previous!,
        status:
          previous!.status === "added"
            ? "removed"
            : previous!.status === "removed"
              ? "added"
              : "modified",
      }
  );
}

export function comparisonSources(
  pair: ComparisonFile,
  oldSha: string,
  newSha: string
) {
  return {
    old: {
      sha: oldSha,
      exists: pair.previous
        ? pair.previous.status !== "removed"
        : pair.current?.status !== "added",
      path:
        pair.previous?.filename ??
        pair.current?.previous_filename ??
        pair.filename,
    },
    new: {
      sha: newSha,
      exists: pair.current
        ? pair.current.status !== "removed"
        : pair.previous?.status !== "added",
      path:
        pair.current?.filename ??
        pair.previous?.previous_filename ??
        pair.filename,
    },
  };
}

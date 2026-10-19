import type { DiffLine, ParsedDiff, DiffSkipBlock } from "./diff-parser";

export async function expandComparisonContext(
  block: DiffSkipBlock,
  sources: NonNullable<ParsedDiff["sources"]>,
  getContent: (path: string, sha: string) => Promise<string>,
  compare: (
    oldContent: string,
    newContent: string,
    filename: string,
    context: number
  ) => Promise<ParsedDiff>,
  highlight: (
    content: string,
    filename: string,
    start: number,
    oldStart: number,
    count: number
  ) => Promise<DiffLine[]>
): Promise<DiffLine[]> {
  const [oldContent, newContent] = await Promise.all([
    sources.old.exists === false
      ? ""
      : getContent(sources.old.path, sources.old.sha),
    sources.new.exists === false
      ? ""
      : getContent(sources.new.path, sources.new.sha),
  ]);
  const oldStart = block.oldStart ?? 1;
  const newStart = block.newStart ?? 1;
  const slice = (content: string, start: number, count: number) => {
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(start - 1, start - 1 + count);
  };
  const oldLines = slice(oldContent, oldStart, block.oldCount ?? block.count);
  const newLines = slice(newContent, newStart, block.newCount ?? block.count);
  if (oldLines.join("\n") === newLines.join("\n"))
    return highlight(
      newContent,
      sources.new.path,
      newStart,
      oldStart,
      newLines.length
    );
  const asContent = (lines: string[]) =>
    lines.length ? lines.join("\n") + "\n" : "";
  const diff = await compare(
    asContent(oldLines),
    asContent(newLines),
    sources.new.path,
    Math.max(oldLines.length, newLines.length)
  );
  return diff.hunks.flatMap((h) =>
    h.type === "hunk"
      ? h.lines.map((line) => ({
          ...line,
          oldLineNumber:
            line.oldLineNumber == null
              ? undefined
              : line.oldLineNumber + oldStart - 1,
          newLineNumber:
            line.newLineNumber == null
              ? undefined
              : line.newLineNumber + newStart - 1,
        }))
      : []
  );
}

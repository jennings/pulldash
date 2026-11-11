import type { FileDiffMetadata, Hunk } from "@pierre/diffs";

type Change = Extract<Hunk["hunkContent"][number], { type: "change" }>;

/** Lines this similar (0-1) or more are shown side by side in split view. */
const MIN_SIMILARITY = 0.5;
/** Larger runs keep Pierre's pairing: the alignment compares every pair. */
const MAX_COMPARISONS = 250_000;

const strip = (line: string) => line.replace(/\s+/g, "");

/** Pierre's measure: shared prefix and suffix over the longer line. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const min = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < min && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < min - prefix && a.at(-1 - suffix) === b.at(-1 - suffix))
    suffix++;
  return (prefix + suffix) / Math.max(a.length, b.length);
}

/**
 * Pairs (deletion, addition) of a run of changed lines that maximize total
 * similarity, in order. Blank lines never pair: they would tie unrelated code.
 */
function alignRun(deleted: string[], added: string[]): [number, number][] {
  const d = deleted.map(strip);
  const a = added.map(strip);
  const score = (i: number, j: number) => {
    if (!d[i] || !a[j]) return 0;
    const s = similarity(d[i]!, a[j]!);
    return s >= MIN_SIMILARITY ? s : 0;
  };
  const best = Array.from({ length: d.length + 1 }, () =>
    new Array<number>(a.length + 1).fill(0)
  );
  for (let i = 1; i <= d.length; i++)
    for (let j = 1; j <= a.length; j++) {
      const s = score(i - 1, j - 1);
      best[i]![j] = Math.max(
        best[i - 1]![j]!,
        best[i]![j - 1]!,
        s > 0 ? best[i - 1]![j - 1]! + s : 0
      );
    }
  const pairs: [number, number][] = [];
  for (let i = d.length, j = a.length; i > 0 && j > 0; ) {
    const s = score(i - 1, j - 1);
    if (s > 0 && best[i]![j] === best[i - 1]![j - 1]! + s) {
      pairs.push([--i, --j]);
    } else if (best[i]![j] === best[i - 1]![j]) i--;
    else j--;
  }
  return pairs.reverse();
}

/** Change blocks for a run, cut so that each similar pair shares a row. */
function realignRun(fileDiff: FileDiffMetadata, run: Change): Change[] | null {
  const { deletions, additions, deletionLineIndex, additionLineIndex } = run;
  if (!deletions || !additions || deletions * additions > MAX_COMPARISONS)
    return null;
  const pairs = alignRun(
    fileDiff.deletionLines.slice(
      deletionLineIndex,
      deletionLineIndex + deletions
    ),
    fileDiff.additionLines.slice(
      additionLineIndex,
      additionLineIndex + additions
    )
  );
  if (pairs.length === 0) return null;
  const blocks: Change[] = [];
  let [i, j] = [0, 0];
  const push = (toI: number, toJ: number) => {
    if (toI === i && toJ === j) return;
    const last = blocks.at(-1);
    // Consecutive pairs share a block: Pierre pairs equal counts in order.
    if (last && toI - i === toJ - j && last.deletions === last.additions) {
      last.deletions += toI - i;
      last.additions += toJ - j;
    } else {
      blocks.push({
        type: "change",
        deletions: toI - i,
        additions: toJ - j,
        deletionLineIndex: deletionLineIndex + i,
        additionLineIndex: additionLineIndex + j,
      });
    }
    [i, j] = [toI, toJ];
  };
  for (const [pi, pj] of pairs) {
    push(pi, pj);
    push(pi + 1, pj + 1);
  }
  push(deletions, additions);
  return blocks;
}

const splitRows = (content: Hunk["hunkContent"]) =>
  content.reduce(
    (n, c) =>
      n + (c.type === "context" ? c.lines : Math.max(c.deletions, c.additions)),
    0
  );

/**
 * Pierre pairs a run of changed lines for split view by position, shifted by
 * at most one offset. Re-pair each run by similarity instead, so a deleted or
 * added line with no counterpart gets a row of its own wherever it is, and
 * keep split row counts in step. Unpaired lines between pairs keep Pierre's
 * positional pairing.
 */
export function pairChangedLines(fileDiff: FileDiffMetadata): void {
  let shift = 0;
  for (const hunk of fileDiff.hunks) {
    hunk.splitLineStart += shift;
    const content: Hunk["hunkContent"] = [];
    for (let k = 0; k < hunk.hunkContent.length; ) {
      const first = hunk.hunkContent[k]!;
      if (first.type === "context") {
        content.push(first);
        k++;
        continue;
      }
      const run: Change[] = [];
      while (hunk.hunkContent[k]?.type === "change")
        run.push(hunk.hunkContent[k++] as Change);
      const merged: Change = {
        ...first,
        deletions: run.reduce((n, c) => n + c.deletions, 0),
        additions: run.reduce((n, c) => n + c.additions, 0),
      };
      content.push(...(realignRun(fileDiff, merged) ?? run));
    }
    const delta = splitRows(content) - splitRows(hunk.hunkContent);
    hunk.hunkContent = content;
    hunk.splitLineCount += delta;
    shift += delta;
  }
  fileDiff.splitLineCount += shift;
}

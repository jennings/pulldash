import { diffChars, diffWords } from "diff";

export interface RawLineSegment {
  value: string;
  type: "insert" | "delete" | "normal";
}

export function diffCharsIfWithinEditLimit(
  a: string,
  b: string,
  maxEdits = 4
):
  | { exceededLimit: true }
  | { exceededLimit: false; diffs: RawLineSegment[] } {
  const diffs = diffChars(a, b);
  let edits = 0;
  for (const part of diffs) {
    if (part.added || part.removed) {
      edits += part.value.length;
      if (edits > maxEdits) return { exceededLimit: true };
    }
  }
  return {
    exceededLimit: false,
    diffs: diffs.map((d) => ({
      value: d.value,
      type: d.added ? "insert" : d.removed ? "delete" : "normal",
    })),
  };
}

export function buildInlineDiffSegments(
  currentContent: string,
  nextContent: string,
  inlineMaxCharEdits: number
): RawLineSegment[] {
  const segments: RawLineSegment[] = diffWords(currentContent, nextContent).map(
    (token) => ({
      value: token.value,
      type: token.added ? "insert" : token.removed ? "delete" : "normal",
    })
  );

  const result: RawLineSegment[] = [];
  const mergeIntoResult = (segment: RawLineSegment) => {
    const last = result[result.length - 1];
    if (last && last.type === segment.type) {
      last.value += segment.value;
    } else {
      result.push(segment);
    }
  };

  for (let i = 0; i < segments.length; i++) {
    const current = segments[i];
    const next = segments[i + 1];
    if (current.type === "delete" && next?.type === "insert") {
      const charDiff = diffCharsIfWithinEditLimit(
        current.value,
        next.value,
        inlineMaxCharEdits
      );
      if (!charDiff.exceededLimit) {
        charDiff.diffs.forEach(mergeIntoResult);
        i++;
      } else {
        result.push(current);
      }
    } else {
      mergeIntoResult(current);
    }
  }

  return result;
}

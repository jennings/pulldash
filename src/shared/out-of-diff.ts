export const OUT_OF_DIFF_MARKER = "<!-- pulldash:out-of-diff";

/** Exact anchoring info for comments whose target line lies outside the diff
 *  hunks. GitHub's API cannot anchor those to a line, so pulldash submits
 *  them as file-level comments and records the real position in the body. */
export interface OutOfDiffInfo {
  line: number;
  startLine?: number;
  side: "LEFT" | "RIGHT";
}

const MARKER_RE =
  /<!-- pulldash:out-of-diff line=(\d+)(?: start_line=(\d+))? side=(LEFT|RIGHT) -->/;

export function parseOutOfDiffMarker(body: string): OutOfDiffInfo | null {
  const match = body.match(MARKER_RE);
  if (!match) return null;
  return {
    line: parseInt(match[1], 10),
    startLine: match[2] ? parseInt(match[2], 10) : undefined,
    side: match[3] as "LEFT" | "RIGHT",
  };
}

export function isOutOfDiffComment(body?: string | null): boolean {
  return !!body?.includes(OUT_OF_DIFF_MARKER);
}

export function buildOutOfDiffMarker(
  line: number,
  startLine: number | undefined,
  side: "LEFT" | "RIGHT"
): string {
  const start = startLine !== undefined ? ` start_line=${startLine}` : "";
  return `<!-- pulldash:out-of-diff line=${line}${start} side=${side} -->`;
}

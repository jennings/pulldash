export const OUT_OF_DIFF_MARKER = "<!-- pulldash:out-of-diff";

/** Exact anchoring info for comments whose target line lies outside the diff
 *  hunks. GitHub's API cannot anchor those to a line, so pulldash submits
 *  them as file-level comments and records the real position in the body. */
export interface OutOfDiffInfo {
  line: number;
  startLine?: number;
  side: "LEFT" | "RIGHT";
  /** Commit the position refers to. Older markers (pre-sha) omit it; the
   *  blob permalink embedded in the body is the fallback source. */
  sha?: string;
}

const MARKER_RE =
  /<!-- pulldash:out-of-diff(?: sha=([0-9a-f]+))? line=(\d+)(?: start_line=(\d+))? side=(LEFT|RIGHT) -->/;

export function parseOutOfDiffMarker(body: string): OutOfDiffInfo | null {
  const match = body.match(MARKER_RE);
  if (!match) return null;
  return {
    line: parseInt(match[2], 10),
    startLine: match[3] ? parseInt(match[3], 10) : undefined,
    side: match[4] as "LEFT" | "RIGHT",
    ...(match[1] ? { sha: match[1] } : {}),
  };
}

export function isOutOfDiffComment(body?: string | null): boolean {
  return !!body?.includes(OUT_OF_DIFF_MARKER);
}

export function buildOutOfDiffMarker(
  line: number,
  startLine: number | undefined,
  side: "LEFT" | "RIGHT",
  sha?: string
): string {
  const withSha = sha ? ` sha=${sha}` : "";
  const start = startLine !== undefined ? ` start_line=${startLine}` : "";
  return `<!-- pulldash:out-of-diff${withSha} line=${line}${start} side=${side} -->`;
}

/** The blob permalink appended to out-of-diff comments, matched anywhere in
 *  a body (raw markdown or pre-rendered HTML). */
const PERMALINK_RE =
  /(?:^|\n|<p[^>]*>)\s*(?:<a[^>]*>)?https:\/\/github\.com\/[^/\s<]+\/[^/\s<]+\/blob\/[0-9a-f]+\/\S+#[^\s<]*(?:<\/a>)?\s*(?:<\/p>)?\s*$/;

/** Remove the trailing blob permalink from a raw body. Pulldash renders the
 *  referenced range itself; the permalink is only there so GitHub embeds the
 *  code snippet. */
export function stripOutOfDiffPermalink(body: string): string {
  const stripped = body.replace(
    /(?:^|\n)\s*https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/blob\/[0-9a-f]+\/\S+#[^\s]*\s*$/,
    ""
  );
  return stripped === body ? body.replace(PERMALINK_RE, "") : stripped;
}

/** Remove the embedded code-snippet block GitHub renders for the permalink
 *  (an empty paragraph, the condensed Box, and a trailing empty paragraph). */
export function stripOutOfDiffPermalinkHtml(bodyHtml: string): string {
  return bodyHtml
    .replace(
      /<p[^>]*>\s*<\/p>\s*<div class="Box Box--condensed[^>]*">[\s\S]*?<\/table>\s*<\/div>\s*<\/div>\s*<p[^>]*>\s*<\/p>\s*$/,
      ""
    )
    .trimEnd();
}

export const COMMIT_METADATA_MARKER = "<!-- pulldash:commit-metadata";

export interface CommitMetadataInfo {
  sha: string;
  line: number;
  label: string;
}

const MARKER_RE =
  /<!-- pulldash:commit-metadata sha=(\S+) line=(\d+) label=(.*?) -->/;

export function parseCommitMetadataMarker(
  body: string
): CommitMetadataInfo | null {
  const match = body.match(MARKER_RE);
  if (!match) return null;
  return {
    sha: match[1],
    line: parseInt(match[2], 10),
    label: match[3],
  };
}

const PREFIX_LINE_RE =
  /^This comment was made on the commit metadata for commit /;

export function isMetadataComment(body?: string | null): boolean {
  return !!body?.includes(COMMIT_METADATA_MARKER);
}

export function getCommentDisplayPath(comment: {
  path: string;
  body?: string | null;
}): string {
  return isMetadataComment(comment.body) ? "Commit metadata" : comment.path;
}

/** Strip the commit metadata prefix and marker from a body string.
 *  Returns the original body unchanged if it's not a metadata comment. */
export function stripCommitMetadataPrefix(body: string): string {
  if (!body.includes(COMMIT_METADATA_MARKER)) return body;

  const markerEnd = body.indexOf("-->", body.indexOf(COMMIT_METADATA_MARKER));
  if (markerEnd === -1) return body;

  // Everything after the marker
  return body.slice(markerEnd + 3).trimStart();
}

const CHANGE_ID_HEADER_RE = /^(?:change-id|Change-Id)(?::\s*|\s+)(\S+)\s*$/m;

/** Parse a change-id or Change-Id from the raw git commit payload header
 *  section (before the first blank line). Returns the id value or null. */
export function parseChangeIdFromPayload(payload: string): string | null {
  // The header section ends at the first blank line
  const headerEnd = payload.indexOf("\n\n");
  const header = headerEnd === -1 ? payload : payload.slice(0, headerEnd);
  return CHANGE_ID_HEADER_RE.exec(header)?.[1] ?? null;
}

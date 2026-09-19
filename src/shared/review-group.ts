export const REVIEW_GROUP_MARKER = "<!-- pulldash:review-group";

export interface ReviewGroupInfo {
  /** Token shared by every review of one submission batch. */
  group: string;
  /** 0-based position within the batch; 0 is the primary review. */
  index: number;
  /** Total reviews in the batch. */
  total: number;
}

const MARKER_RE = /<!-- pulldash:review-group g=(\S+) i=(\d+) n=(\d+) -->/;

export function reviewGroupMarker(
  group: string,
  index: number,
  total: number
): string {
  return `<!-- pulldash:review-group g=${group} i=${index} n=${total} -->`;
}

export function parseReviewGroupMarker(body: string): ReviewGroupInfo | null {
  const match = body.match(MARKER_RE);
  if (!match) return null;
  return {
    group: match[1],
    index: parseInt(match[2], 10),
    total: parseInt(match[3], 10),
  };
}

/** Strip the marker and any leading whitespace it left behind. Returns the
 *  body unchanged when no well-formed marker is present. */
export function stripReviewGroupMarker(body: string): string {
  const match = body.match(MARKER_RE);
  if (!match) return body;
  return body.replace(match[0], "").trimStart();
}

/** Editor hygiene: comment bodies carry the marker, but the edit textarea
 *  shows it stripped. Re-attach the original marker to an edited body. */
export function withReviewGroupMarker(
  originalBody: string,
  editedBody: string
): string {
  const marker = parseReviewGroupMarker(originalBody);
  if (!marker || parseReviewGroupMarker(editedBody)) return editedBody;
  return `${reviewGroupMarker(marker.group, marker.index, marker.total)}\n${editedBody}`;
}

export interface MarkedReview {
  reviewId: number;
  info: ReviewGroupInfo;
}

/** Correlate marker-bearing reviews of the same submission batch. Returns
 *  member->primary (lowest index) and primary->members (ordered by index). */
export function reviewGroups(marked: MarkedReview[]): {
  memberToPrimary: Map<number, number>;
  primaryToMembers: Map<number, MarkedReview[]>;
} {
  const batches = new Map<string, MarkedReview[]>();
  for (const entry of marked) {
    const batch = batches.get(entry.info.group) ?? [];
    batch.push(entry);
    batches.set(entry.info.group, batch);
  }

  const memberToPrimary = new Map<number, number>();
  const primaryToMembers = new Map<number, MarkedReview[]>();
  for (const batch of batches.values()) {
    batch.sort((a, b) => a.info.index - b.info.index);
    const primary = batch[0];
    primaryToMembers.set(primary.reviewId, batch);
    for (const member of batch) {
      memberToPrimary.set(member.reviewId, primary.reviewId);
    }
  }
  return { memberToPrimary, primaryToMembers };
}

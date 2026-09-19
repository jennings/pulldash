import { describe, test, expect } from "bun:test";
import {
  parseReviewGroupMarker,
  reviewGroupMarker,
  reviewGroups,
  stripReviewGroupMarker,
  withReviewGroupMarker,
} from "./review-group";

const MARKER = reviewGroupMarker("abc123", 0, 3);

describe("parseReviewGroupMarker", () => {
  test("parses group, index, and total", () => {
    expect(parseReviewGroupMarker(`prefix\n${MARKER}\nbody`)).toEqual({
      group: "abc123",
      index: 0,
      total: 3,
    });
  });

  test("returns null without a marker", () => {
    expect(parseReviewGroupMarker("just text")).toBeNull();
  });

  test("returns null for a malformed marker", () => {
    expect(
      parseReviewGroupMarker("<!-- pulldash:review-group g=x -->")
    ).toBeNull();
    expect(parseReviewGroupMarker("<!-- pulldash:review-group")).toBeNull();
  });
});

describe("stripReviewGroupMarker", () => {
  test("removes the marker and leading whitespace", () => {
    expect(stripReviewGroupMarker(`${MARKER}\n\nsome review text`)).toBe(
      "some review text"
    );
    expect(stripReviewGroupMarker("no marker")).toBe("no marker");
  });

  test("keeps content after the marker", () => {
    expect(
      stripReviewGroupMarker(`${MARKER}\n_Snap notice._\n\nactual text`)
    ).toBe("_Snap notice._\n\nactual text");
  });
});

describe("withReviewGroupMarker", () => {
  test("re-attaches the original marker to an edited body", () => {
    const original = `${MARKER}\noriginal text`;
    expect(withReviewGroupMarker(original, "edited text")).toBe(
      `${MARKER}\nedited text`
    );
  });

  test("leaves bodies without a marker alone", () => {
    expect(withReviewGroupMarker("plain", "edited")).toBe("edited");
  });

  test("does not double-inject when the edited body already has one", () => {
    const other = reviewGroupMarker("other", 1, 2);
    expect(withReviewGroupMarker(`${MARKER}\norig`, `${other}\nedited`)).toBe(
      `${other}\nedited`
    );
  });
});

describe("reviewGroups", () => {
  test("maps members to the lowest-index primary and orders members", () => {
    const marked = [
      { reviewId: 2, info: { group: "g1", index: 1, total: 3 } },
      { reviewId: 1, info: { group: "g1", index: 0, total: 3 } },
      { reviewId: 3, info: { group: "g1", index: 2, total: 3 } },
      { reviewId: 9, info: { group: "g2", index: 0, total: 1 } },
    ];
    const { memberToPrimary, primaryToMembers } = reviewGroups(marked);
    expect(memberToPrimary.get(1)).toBe(1);
    expect(memberToPrimary.get(2)).toBe(1);
    expect(memberToPrimary.get(3)).toBe(1);
    expect(primaryToMembers.get(1)?.map((m) => m.reviewId)).toEqual([1, 2, 3]);
    expect(primaryToMembers.get(9)?.map((m) => m.reviewId)).toEqual([9]);
  });

  test("keeps different tokens separate", () => {
    const marked = [
      { reviewId: 1, info: { group: "a", index: 0, total: 1 } },
      { reviewId: 2, info: { group: "b", index: 0, total: 1 } },
    ];
    const { memberToPrimary } = reviewGroups(marked);
    expect(memberToPrimary.get(1)).toBe(1);
    expect(memberToPrimary.get(2)).toBe(2);
  });
});

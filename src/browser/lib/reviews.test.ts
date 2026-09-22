import { test, expect } from "bun:test";
import {
  getLatestReviewByUser,
  getLatestReviewsByUser,
  groupCommentsByLineSide,
  resolveCommentPosition,
} from "./reviews";
import type { Review } from "@/api/types";

function review(
  login: string,
  state: Review["state"],
  submitted_at: string,
  id: number
): Review {
  return {
    id,
    state,
    submitted_at,
    user: { login, avatar_url: "", html_url: "" },
  } as unknown as Review;
}

// Real-world shape of a PR where approvals are followed by comment reviews:
// comments must not mask the earlier approval decision.
const fixture: Review[] = [
  review("gduperrey", "APPROVED", "2026-08-27T14:46:13Z", 1),
  review("rzr", "COMMENTED", "2026-08-31T15:26:13Z", 2),
  review("olivierh-pro", "APPROVED", "2026-09-03T08:19:11Z", 3),
  review("glehmann", "COMMENTED", "2026-09-03T08:23:09Z", 4),
  review("rzr", "APPROVED", "2026-09-03T08:31:25Z", 5),
  review("gduperrey", "COMMENTED", "2026-09-03T08:48:58Z", 6),
  review("olivierh-pro", "COMMENTED", "2026-09-03T12:18:21Z", 7),
  review("glehmann", "COMMENTED", "2026-09-03T15:41:52Z", 8),
];

test("comment reviews after an approval do not mask it", () => {
  const decisions = getLatestReviewsByUser(fixture);
  expect(decisions.map((r) => r.user!.login).sort()).toEqual([
    "gduperrey",
    "olivierh-pro",
    "rzr",
  ]);
  expect(decisions.every((r) => r.state === "APPROVED")).toBe(true);
});

test("comment-only reviewers fall back to their latest comment", () => {
  const byUser = getLatestReviewByUser(fixture);
  expect(byUser.get("glehmann")?.state).toBe("COMMENTED");
  expect(byUser.get("glehmann")?.id).toBe(8);
});

// xcp-ng-tests#709: glehmann approved, the author re-requested, then glehmann
// left a comment review — GitHub's reviewer badge shows COMMENTED while the
// approval still counts for merge readiness.
const badgeFixture: Review[] = [
  review("glehmann", "APPROVED", "2026-09-18T12:38:47Z", 1),
  review("glehmann", "COMMENTED", "2026-09-23T07:55:49Z", 2),
];

test("comment review downgrades the badge but not the merge decision", () => {
  expect(getLatestReviewByUser(badgeFixture).get("glehmann")?.state).toBe(
    "COMMENTED"
  );
  expect(getLatestReviewsByUser(badgeFixture)[0].state).toBe("APPROVED");
});

test("requesting changes overrides an earlier approval", () => {
  const reviews = [
    review("a", "APPROVED", "2026-01-01T00:00:00Z", 1),
    review("a", "CHANGES_REQUESTED", "2026-01-02T00:00:00Z", 2),
  ];
  expect(getLatestReviewsByUser(reviews)[0].state).toBe("CHANGES_REQUESTED");
});

test("dismissed reviews are not treated as decisions", () => {
  const reviews = [
    review("a", "APPROVED", "2026-01-01T00:00:00Z", 1),
    review("a", "DISMISSED", "2026-01-02T00:00:00Z", 2),
  ];
  expect(getLatestReviewsByUser(reviews)).toEqual([]);
  expect(getLatestReviewByUser(reviews).has("a")).toBe(false);
});

// Three hunks with gaps at lines 5-26 and 34-56 — the shape of a PR whose
// diff only shows changed regions.
const patch = [
  "@@ -1,4 +1,4 @@",
  "-line 1",
  "+line 1 changed",
  " line 2",
  " line 3",
  " line 4",
  "@@ -27,7 +27,7 @@ line 26",
  " line 27",
  " line 28",
  " line 29",
  "-line 30",
  "+line 30 changed",
  " line 31",
  " line 32",
  " line 33",
  "@@ -57,4 +57,4 @@ line 56",
  " line 57",
  " line 58",
  " line 59",
  "-line 60",
  "+line 60 changed",
].join("\n");

test("comment inside the diff is left alone", () => {
  expect(resolveCommentPosition({ line: 29, side: "RIGHT" }, patch)).toEqual({
    line: 29,
    adjusted: false,
  });
  expect(resolveCommentPosition({ line: 30, side: "LEFT" }, patch)).toEqual({
    line: 30,
    adjusted: false,
  });
});

test("comment outside the diff snaps to the nearest hunk line", () => {
  expect(resolveCommentPosition({ line: 20, side: "RIGHT" }, patch)).toEqual({
    line: 27,
    adjusted: true,
  });
  expect(resolveCommentPosition({ line: 55, side: "LEFT" }, patch)).toEqual({
    line: 57,
    adjusted: true,
  });
  expect(resolveCommentPosition({ line: 0, side: "RIGHT" }, patch)).toEqual({
    line: 1,
    adjusted: true,
  });
});

test("multi-line comment spanning hunks becomes a single-line comment", () => {
  expect(
    resolveCommentPosition({ line: 60, start_line: 2, side: "RIGHT" }, patch)
  ).toEqual({ line: 60, adjusted: true });
});

test("multi-line comment within one hunk keeps both endpoints", () => {
  expect(
    resolveCommentPosition({ line: 29, start_line: 27, side: "RIGHT" }, patch)
  ).toEqual({ line: 29, start_line: 27, adjusted: false });
});

test("multi-line comment with an outside endpoint becomes a single line", () => {
  expect(
    resolveCommentPosition({ line: 29, start_line: 5, side: "RIGHT" }, patch)
  ).toEqual({ line: 29, adjusted: true });
  expect(
    resolveCommentPosition({ line: 20, start_line: 2, side: "RIGHT" }, patch)
  ).toEqual({ line: 27, adjusted: true });
});

test("comments are unchanged without patch data", () => {
  expect(resolveCommentPosition({ line: 900, side: "RIGHT" }, null)).toEqual({
    line: 900,
    adjusted: false,
  });
});

test("snapping respects side-specific hunk ranges", () => {
  // Deletion hunk: LEFT covers 10-12, RIGHT covers 10-11. Line 12 exists on
  // the LEFT but not the RIGHT, so only the RIGHT comment snaps.
  const deletionPatch = [
    "@@ -10,3 +10,2 @@",
    " line 10",
    "-line 11",
    " line 12",
  ].join("\n");
  expect(
    resolveCommentPosition({ line: 12, side: "LEFT" }, deletionPatch)
  ).toEqual({ line: 12, adjusted: false });
  expect(
    resolveCommentPosition({ line: 12, side: "RIGHT" }, deletionPatch)
  ).toEqual({ line: 11, adjusted: true });
});

test("comments sharing a line number are grouped by side", () => {
  const comments = [
    { id: "left", line: 525, side: "LEFT" as const },
    { id: "right", line: 525, side: "RIGHT" as const },
  ];
  const byLineSide = groupCommentsByLineSide(comments);
  expect(byLineSide.get("525:old")?.map((c) => c.id)).toEqual(["left"]);
  expect(byLineSide.get("525:new")?.map((c) => c.id)).toEqual(["right"]);
});

import { describe, test, expect } from "bun:test";
import type { PullRequestFile, ReviewComment } from "@/api/types";
import {
  groupPendingCommentsByTarget,
  pendingTargetSha,
  prepareGroupComments,
  sameSubmittedComments,
  type PendingCommentInput,
} from "./review-submit";

const HEAD = "head0000000000000000000000000000000099";
const COMMIT_A = "aaaa0000000000000000000000000000000000aa";
const COMMIT_B = "bbbb0000000000000000000000000000000000bb";

function makeComment(
  overrides: Partial<PendingCommentInput> = {}
): PendingCommentInput {
  return {
    id: "c1",
    path: "src/index.ts",
    line: 10,
    body: "test",
    side: "RIGHT",
    ...overrides,
  };
}

describe("groupPendingCommentsByTarget", () => {
  test("groups head comments first, then other commits in creation order", () => {
    const groups = groupPendingCommentsByTarget(
      [
        makeComment({ id: "1", targetSha: COMMIT_A }),
        makeComment({ id: "2" }),
        makeComment({ id: "3", targetSha: COMMIT_B }),
        makeComment({ id: "4", targetSha: COMMIT_A }),
      ],
      HEAD
    );

    expect(groups.map((g) => g.sha)).toEqual([HEAD, COMMIT_A, COMMIT_B]);
    expect(groups[0].comments.map((c) => c.id)).toEqual(["2"]);
    expect(groups[1].comments.map((c) => c.id)).toEqual(["1", "4"]);
    expect(groups[2].comments.map((c) => c.id)).toEqual(["3"]);
  });

  test("all-head sessions produce a single head group", () => {
    const groups = groupPendingCommentsByTarget(
      [makeComment({ id: "1" }), makeComment({ id: "2" })],
      HEAD
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].sha).toBe(HEAD);
    expect(groups[0].comments).toHaveLength(2);
  });
});

describe("pendingTargetSha", () => {
  test("falls back to the head sha", () => {
    expect(pendingTargetSha(makeComment(), HEAD)).toBe(HEAD);
    expect(pendingTargetSha(makeComment({ targetSha: COMMIT_A }), HEAD)).toBe(
      COMMIT_A
    );
  });
});

describe("prepareGroupComments", () => {
  const files = [
    {
      filename: "src/first.ts",
      patch: "@@ -1,3 +1,4 @@\n context\n-old\n+new\n+added\n",
    },
    {
      filename: "src/other.ts",
      patch: "@@ -20,3 +20,3 @@\n a\n-b\n+c\n",
    },
  ] as PullRequestFile[];

  test("redirects :commit metadata comments to the first file's first hunk", () => {
    const prepared = prepareGroupComments(
      [makeComment({ id: "m", path: ":commit", line: 3, body: "meta" })],
      files
    );
    expect(prepared[0].payload.path).toBe("src/first.ts");
    expect(prepared[0].payload.line).toBe(1);
  });

  test("throws when metadata comments have no files to redirect to", () => {
    expect(() =>
      prepareGroupComments(
        [makeComment({ id: "m", path: ":commit", line: 3 })],
        []
      )
    ).toThrow("Cannot submit commit-metadata comments");
  });

  test("keeps lines already inside the diff unchanged", () => {
    const prepared = prepareGroupComments(
      [
        makeComment({
          id: "1",
          path: "src/first.ts",
          line: 2,
          start_line: 1,
          side: "RIGHT",
        }),
      ],
      files
    );
    expect(prepared[0].payload).toEqual({
      path: "src/first.ts",
      line: 2,
      start_line: 1,
      start_side: "RIGHT",
      side: "RIGHT",
      body: "test",
    });
  });

  test("snaps lines outside the diff to the nearest diff line and notes it", () => {
    const prepared = prepareGroupComments(
      [
        makeComment({ id: "1", path: "src/first.ts", line: 40 }),
        makeComment({
          id: "2",
          path: "src/first.ts",
          line: 40,
          start_line: 38,
          side: "LEFT",
        }),
      ],
      files
    );
    expect(prepared[0].payload.line).toBe(4);
    expect(prepared[0].payload.body).toContain(
      "originally on line 40, which is outside the diff"
    );
    // Multi-line ranges that cannot stay intact collapse to a single line.
    expect(prepared[1].payload.start_line).toBeUndefined();
    expect(prepared[1].payload.body).toContain("originally on line 40");
  });

  test("leaves comments for files missing from the diff unsnapped", () => {
    const prepared = prepareGroupComments(
      [makeComment({ id: "1", path: "src/unknown.ts", line: 7 })],
      files
    );
    expect(prepared[0].payload.line).toBe(7);
    expect(prepared[0].payload.body).toBe("test");
  });
});

describe("sameSubmittedComments", () => {
  const payload = {
    path: "src/index.ts",
    line: 10,
    side: "RIGHT" as const,
    body: "test",
  };

  const submitted = (overrides: Partial<ReviewComment>): ReviewComment =>
    ({
      path: "src/index.ts",
      line: 10,
      side: "RIGHT",
      body: "test",
      ...overrides,
    }) as unknown as ReviewComment;

  test("matches identical comment sets regardless of order", () => {
    const payloads = [
      payload,
      { path: "b.ts", line: 2, side: "LEFT" as const, body: "other" },
    ];
    const sent = [
      submitted({ body: "other", path: "b.ts", side: "LEFT", line: 2 }),
      submitted({}),
    ];
    expect(sameSubmittedComments(sent, payloads)).toBe(true);
  });

  test("does not match on different bodies, sides, or counts", () => {
    expect(
      sameSubmittedComments([submitted({ body: "different" })], [payload])
    ).toBe(false);
    expect(
      sameSubmittedComments([submitted({ side: "LEFT" })], [payload])
    ).toBe(false);
    expect(sameSubmittedComments([], [payload])).toBe(false);
  });

  test("treats a missing side on the response as RIGHT", () => {
    expect(
      sameSubmittedComments([submitted({ side: undefined })], [payload])
    ).toBe(true);
  });

  test("ignores regenerated review-group markers on retry", () => {
    const sent = submitted({
      body: "<!-- pulldash:review-group g=old i=0 n=2 -->\ntest",
    });
    const retry = {
      ...payload,
      body: "<!-- pulldash:review-group g=new i=0 n=2 -->\ntest",
    };
    expect(sameSubmittedComments([sent], [retry])).toBe(true);
  });
});

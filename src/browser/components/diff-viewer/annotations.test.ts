import { expect, test } from "bun:test";
import type { ReviewComment } from "@/api/types";
import { buildOutOfDiffMarker } from "@/shared/out-of-diff";
import type { LocalPendingComment } from "../../contexts/pr-review";
import {
  buildAnnotations,
  buildCommentLayout,
  stabilizeAnnotations,
  type CommentLayout,
} from "./annotations";

let nextId = 1;
const comment = (overrides: Partial<ReviewComment>): ReviewComment =>
  ({
    id: nextId++,
    body: "text",
    path: "f.ts",
    line: 5,
    side: "RIGHT",
    commit_id: "abcdef1234",
    subject_type: "line",
    ...overrides,
  }) as ReviewComment;

const pending = (
  overrides: Partial<LocalPendingComment>
): LocalPendingComment =>
  ({
    id: `p${nextId++}`,
    path: "f.ts",
    line: 5,
    side: "RIGHT",
    body: "draft",
    ...overrides,
  }) as LocalPendingComment;

const layoutFor = (
  comments: ReviewComment[],
  pendingComments: LocalPendingComment[] = [],
  resolveLine: (c: ReviewComment) => number | null = (c) => c.line ?? null
): CommentLayout =>
  buildCommentLayout({
    comments,
    pendingComments,
    viewedCommitSha: "abcdef1234",
    resolveLine,
  });

test("threads sit on their resolved line and side, with replies attached", () => {
  const root = comment({ id: 1, line: 5, side: "RIGHT" });
  const reply = comment({ id: 2, in_reply_to_id: 1, line: 5 });
  const deleted = comment({ id: 3, line: 2, side: "LEFT" });
  const moved = comment({ id: 4, line: 9 });
  const layout = layoutFor([root, reply, deleted, moved], [], (c) =>
    c.id === 4 ? 12 : (c.line ?? null)
  );
  expect(
    layout.threads.map((t) => [t.line, t.side, t.comments.length])
  ).toEqual([
    [2, "old", 1],
    [5, "new", 2],
    [12, "new", 1],
  ]);
  expect(layout.threadsByKey.get("thread:1")).toEqual([root, reply]);
  // Re-anchored comments keep only their own line highlighted: their stored
  // range is in another commit's coordinates.
  expect([...layout.anchorLines].sort()).toEqual(["12:new", "2:old", "5:new"]);
});

test("comment ranges follow start_line only for comments that are not re-anchored", () => {
  const ranged = comment({ id: 1, line: 8, start_line: 6 });
  const reanchored = comment({ id: 2, line: 8, start_line: 6 });
  const layout = layoutFor([ranged, reanchored], [], (c) =>
    c.id === 2 ? 20 : (c.line ?? null)
  );
  expect([...layout.rangeLines].sort()).toEqual([
    "20:new",
    "6:new",
    "7:new",
    "8:new",
  ]);
});

test("file-level comments go above the diff; out-of-diff markers place them on their real line", () => {
  const fileThread = comment({ id: 1, subject_type: "file", line: 1 });
  const fileReply = comment({
    id: 2,
    subject_type: "file",
    in_reply_to_id: 1,
  });
  const outOfDiff = comment({
    id: 3,
    subject_type: "file",
    body: `${buildOutOfDiffMarker(40, 38, "RIGHT")}\nnote`,
  });
  const outOfDiffReply = comment({
    id: 4,
    subject_type: "file",
    in_reply_to_id: 3,
  });
  const otherCommit = comment({
    id: 5,
    subject_type: "file",
    commit_id: "ffffff9999",
    body: buildOutOfDiffMarker(50, undefined, "RIGHT"),
  });
  const layout = layoutFor([
    fileThread,
    fileReply,
    outOfDiff,
    outOfDiffReply,
    otherCommit,
  ]);
  expect(layout.fileThreads.map((t) => t.comments.map((c) => c.id))).toEqual([
    [1, 2],
  ]);
  expect(
    layout.threads.map((t) => [t.line, t.comments.map((c) => c.id)])
  ).toEqual([[40, [3, 4]]]);
  expect(layout.threads[0].comments[0]).toMatchObject({
    line: 40,
    start_line: 38,
  });
  expect(layout.rangeLines.has("39:new")).toBe(true);
});

test("a thread that resolves to several lines is shown once, at its first", () => {
  const a = comment({ id: 1, pull_request_review_thread_id: "T1" });
  const b = comment({
    id: 2,
    in_reply_to_id: 1,
    pull_request_review_thread_id: "T1",
  });
  const sameThreadElsewhere = comment({
    id: 3,
    pull_request_review_thread_id: "T1",
  });
  const layout = layoutFor([a, b, sameThreadElsewhere], [], (c) =>
    c.id === 3 ? 30 : 5
  );
  expect(layout.threads.map((t) => t.line)).toEqual([5]);
});

test("pending comments are keyed by line and side", () => {
  const onNew = pending({ id: "a", line: 5, side: "RIGHT" });
  const onOld = pending({ id: "b", line: 5, side: "LEFT", start_line: 3 });
  const layout = layoutFor([], [onNew, onOld]);
  expect(layout.pending.map((p) => [p.key, p.side])).toEqual([
    ["pending:a", "new"],
    ["pending:b", "old"],
  ]);
  expect(layout.pendingByKey.get("pending:b")).toBe(onOld);
  expect([...layout.rangeLines].sort()).toEqual([
    "3:old",
    "4:old",
    "5:new",
    "5:old",
  ]);
});

test("buildAnnotations puts the composer last and never moves existing entries", () => {
  const comments = [comment({ id: 1, line: 5 }), comment({ id: 2, line: 9 })];
  const build = (
    pendingComments: LocalPendingComment[],
    composer: { line: number; side: "new" } | null
  ) =>
    buildAnnotations({
      layout: layoutFor(comments, pendingComments),
      composer,
      commentsHidden: false,
      isLineHidden: () => false,
      fileSide: "additions",
    });
  const keys = (list: ReturnType<typeof build>) =>
    list.map((a) => a.metadata?.key);

  const base = build([], null);
  expect(keys(base)).toEqual(["thread:1", "thread:2"]);

  // Pierre keys slots by index: opening the composer on a line that has
  // threads must not shift any of them.
  const withComposer = build([], { line: 5, side: "new" });
  expect(keys(withComposer)).toEqual(["thread:1", "thread:2", "composer"]);

  const withPending = build([pending({ id: "a" })], { line: 5, side: "new" });
  expect(keys(withPending)).toEqual([
    "thread:1",
    "thread:2",
    "pending:a",
    "composer",
  ]);
  expect(keys(withPending).slice(0, 2)).toEqual(keys(base));
  expect(withComposer.at(-1)).toEqual({
    side: "additions",
    lineNumber: 5,
    metadata: { kind: "composer", key: "composer" },
  });
});

test("file-level threads are line 0 annotations on the side that exists", () => {
  const layout = layoutFor([comment({ id: 1, subject_type: "file" })]);
  const build = (fileSide: "additions" | "deletions") =>
    buildAnnotations({
      layout,
      composer: null,
      commentsHidden: false,
      isLineHidden: () => false,
      fileSide,
    });
  expect(build("additions")).toEqual([
    {
      side: "additions",
      lineNumber: 0,
      metadata: { kind: "file-thread", key: "file:1" },
    },
  ]);
  expect(build("deletions")[0].side).toBe("deletions");
});

test("hiding comments leaves a fold toggle per commented line, unless the line is unfolded", () => {
  const layout = layoutFor([
    comment({ id: 1, line: 5 }),
    comment({ id: 2, in_reply_to_id: 1, line: 5 }),
    comment({ id: 3, line: 9 }),
  ]);
  const build = (unfolded: number[]) =>
    buildAnnotations({
      layout,
      composer: null,
      commentsHidden: true,
      isLineHidden: (line) => !unfolded.includes(line),
      fileSide: "additions",
    }).map((a) => [a.lineNumber, a.metadata?.kind, a.metadata?.expanded]);
  expect(build([])).toEqual([
    [5, "fold", false],
    [9, "fold", false],
  ]);
  expect(build([9])).toEqual([
    [5, "fold", false],
    [9, "fold", true],
    [9, "thread", undefined],
  ]);
  expect(
    buildAnnotations({
      layout,
      composer: null,
      commentsHidden: true,
      isLineHidden: () => true,
      fileSide: "additions",
    })[0].metadata?.count
  ).toBe(2);
});

test("stabilizeAnnotations keeps the previous array when nothing moved", () => {
  const layout = layoutFor([comment({ id: 1, line: 5 })]);
  const build = (line: number) =>
    buildAnnotations({
      layout: layoutFor([comment({ id: 1, line })]),
      composer: null,
      commentsHidden: false,
      isLineHidden: () => false,
      fileSide: "additions",
    });
  expect(layout.threads).toHaveLength(1);
  const first = build(5);
  expect(stabilizeAnnotations(first, build(5))).toBe(first);
  const moved = build(6);
  expect(stabilizeAnnotations(first, moved)).toBe(moved);
  expect(stabilizeAnnotations(undefined, first)).toBe(first);
});

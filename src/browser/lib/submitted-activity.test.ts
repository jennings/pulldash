import { expect, test } from "bun:test";
import type { IssueComment, Review, ReviewComment } from "@/api/types";
import type { ReviewThread, TimelineEvent } from "../contexts/github";
import { SubmittedActivityBuffer } from "./submitted-activity";

const review = {
  id: 42,
  state: "COMMENTED",
  body: "Summary",
  submitted_at: "2026-01-02",
} as Review;
const comment = {
  id: 73,
  body: "Conversation",
  created_at: "2026-01-02",
} as IssueComment;
const reviewed = { id: 42, event: "reviewed" } as TimelineEvent;
const commented = { id: 73, event: "commented" } as TimelineEvent;
const thread = (id: string, reviewId = 42, databaseId = 0): ReviewThread => ({
  id,
  isResolved: false,
  isOutdated: false,
  resolvedBy: null,
  pullRequestReview: { databaseId: reviewId, author: null },
  comments: {
    nodes: [
      {
        id: `node-${id}`,
        databaseId,
        body: "Inline",
        path: "a.ts",
        line: 1,
        originalLine: 1,
        startLine: null,
        diffHunk: null,
        author: null,
        createdAt: "2026-01-02",
        updatedAt: "2026-01-02",
        replyTo: null,
      },
    ],
  },
});

test("each list acknowledges accepted content independently and later server deletions are respected", () => {
  const buffer = new SubmittedActivityBuffer();
  const optimistic = thread("pending-thread-draft");
  const fileComment = { id: 11, body: "File comment" } as ReviewComment;
  buffer.add({
    reviews: [review],
    conversation: [comment],
    threads: [optimistic],
    comments: [fileComment],
  });
  expect(buffer.mergeTimeline([reviewed, commented])).toHaveLength(2);
  expect(buffer.mergeReviews([])[0]?.body).toBe("Summary");
  expect(buffer.mergeConversation([])).toEqual([comment]);
  expect(buffer.mergeThreads([])).toEqual([optimistic]);
  expect(buffer.mergeComments([])).toEqual([fileComment]);

  expect(
    buffer.mergeReviews([{ ...review, state: "PENDING", body: "" }])[0]?.body
  ).toBe("Summary");
  expect(buffer.mergeReviews([{ ...review, body: "" }])[0]?.body).toBe(
    "Summary"
  );
  expect(buffer.mergeReviews([review])).toHaveLength(1);
  expect(buffer.mergeTimeline([])).toEqual([]);
  expect(buffer.mergeConversation([comment])).toHaveLength(1);
  const serverThread = thread("server-thread", 42, 91);
  expect(buffer.mergeThreads([serverThread])).toEqual([serverThread]);
  expect(buffer.mergeComments([fileComment])).toHaveLength(1);

  expect(buffer.mergeReviews([])).toEqual([]);
  expect(buffer.mergeConversation([])).toEqual([]);
  expect(buffer.mergeThreads([])).toEqual([]);
  expect(buffer.mergeComments([])).toEqual([]);
});

test("thread reconciliation matches known IDs or review-scoped content, without mutating fetched arrays", () => {
  const buffer = new SubmittedActivityBuffer();
  const optimistic = thread("pending", 42, 101);
  const localOnly = thread("local-only", 43);
  buffer.add({ threads: [optimistic, localOnly] });
  const existing = thread("unrelated", 99, 102);
  const fetched = [existing];
  expect(buffer.mergeThreads(fetched)).toHaveLength(3);
  expect(fetched).toEqual([existing]);
  const server = thread("real", 42, 101);
  expect(buffer.mergeThreads([server])).toEqual([server, localOnly]);
  const matching = thread("real-local-only", 43, 103);
  expect(buffer.mergeThreads([server, matching])).toEqual([server, matching]);
});

test("publishing a second accepted item does not acknowledge the first from local state", () => {
  const buffer = new SubmittedActivityBuffer();
  buffer.add({ reviews: [review] });
  const local = buffer.mergeReviews([], false);
  buffer.add({ conversation: [comment] });
  expect(buffer.mergeReviews(local, false)).toEqual([review]);
  expect(buffer.mergeReviews([])).toEqual([review]);
});

test("editing or deleting confirmed comments before list acknowledgement does not restore old content", () => {
  const buffer = new SubmittedActivityBuffer();
  const pending = thread("pending", 42, 11);
  const comment = { id: 11, body: "Inline" } as ReviewComment;
  buffer.add({ comments: [comment], threads: [pending] });
  const edited = {
    ...pending,
    comments: { nodes: [{ ...pending.comments.nodes[0]!, body: "Edited" }] },
  };
  buffer.updateLocalComments([{ ...comment, body: "Edited" }], [edited]);
  expect(buffer.mergeComments([])[0]?.body).toBe("Edited");
  expect(buffer.mergeThreads([])[0]?.comments.nodes[0]?.body).toBe("Edited");
  buffer.updateLocalComments([], []);
  expect(buffer.mergeComments([])).toEqual([]);
  expect(buffer.mergeThreads([])).toEqual([]);
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { IssueComment, PullRequest, Review } from "@/api/types";
import type { GitHubStore } from "../github";
import { PRReviewStore } from ".";
import { submitReview } from "./useReviewActions";
import { buildOverviewTimeline } from "../../lib/overview-timeline";

const originalStorage = globalThis.localStorage;
beforeEach(() => {
  const values = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: () => null,
    length: 0,
  };
});
afterEach(() => {
  globalThis.localStorage = originalStorage;
});

function setup() {
  const pr = {
    number: 1,
    html_url: "https://github.com/o/r/pull/1",
    head: { sha: "head" },
    base: { sha: "base" },
    user: { login: "author", avatar_url: "" },
    created_at: "2026-01-01",
    state: "open",
  } as PullRequest;
  const github = {
    invalidatePR: () => {},
    getPendingReview: async () => null,
    getPR: async () => pr,
    getPRFiles: async () => [],
    getPRComments: async () => [],
    getPRReviews: async () => [],
    getPRConversation: async () => [],
    getPRTimeline: async () => [],
    getReviewThreads: async () => ({ threads: [] }),
  } as unknown as GitHubStore;
  const store = new PRReviewStore(github, {
    owner: "o",
    repo: "r",
    pr,
    files: [],
    comments: [],
    viewerPermission: "WRITE",
  });
  store.setCurrentUser("reviewer");
  let reconciliation!: Promise<void>;
  const refresh = store.refreshSubmittedActivity;
  store.refreshSubmittedActivity = () => (reconciliation = refresh());
  return { store, github, reconciled: () => reconciliation };
}

test("GraphQL submission publishes summary and inline thread before a held refetch, then survives stale lists", async () => {
  const { store, github, reconciled } = setup();
  const reviews = Promise.withResolvers<Review[]>();
  github.getPRReviews = () => reviews.promise;
  github.getPendingReview = async () => ({
    id: "review-node",
    databaseId: 42,
    viewerDidAuthor: true,
    comments: { nodes: [] },
  });
  github.getPRFiles = async () =>
    [{ filename: "a.ts", patch: "@@ -1 +1 @@\n-old\n+new" }] as Awaited<
      ReturnType<GitHubStore["getPRFiles"]>
    >;
  github.submitPendingReview = async () => ({
    databaseId: 42,
    submittedAt: "2026-01-02",
  });
  store.setPendingReviewNodeId("review-node");
  store.setReviewBody("My review summary");
  store.setPendingComments([
    {
      id: "draft",
      path: "a.ts",
      line: 1,
      body: "Inline comment",
      side: "RIGHT",
      databaseId: 11,
      nodeId: "comment-node",
    },
  ]);

  await submitReview(store, github, "COMMENT");
  expect(store.getSnapshot().submittingReview).toBe(false);
  expect(store.getSnapshot().reviewBody).toBe("");
  expect(store.getSnapshot().overviewScrollTarget).toBe("pullrequestreview-42");
  const model = buildOverviewTimeline(store.getSnapshot());
  expect(model.navigationIds).toContain("pullrequestreview-42");
  const card = model.entries.find((entry) => entry.type === "review");
  expect(card?.type === "review" && card.data.body).toBe("My review summary");
  expect(
    card?.type === "review" && card.threads[0]?.comments.nodes[0]?.body
  ).toBe("Inline comment");

  reviews.resolve([]);
  await reconciled();
  expect(store.getSnapshot().reviews[0]?.body).toBe("My review summary");
  expect(store.getSnapshot().reviewThreads).toHaveLength(1);
  expect(buildOverviewTimeline(store.getSnapshot()).navigationIds).toContain(
    "pullrequestreview-42"
  );
});

test("summary-only submission publishes and targets the returned conversation comment, not an old review", async () => {
  const { store, github, reconciled } = setup();
  const conversation = Promise.withResolvers<IssueComment[]>();
  github.getPRConversation = () => conversation.promise;
  const comment = {
    id: 73,
    body: "Summary only",
    user: { login: "reviewer" },
    created_at: "2026-01-02",
  } as IssueComment;
  github.createPRConversationComment = async () => comment;
  store.setReviews([
    { id: 5, body: "An older review", state: "COMMENTED" } as Review,
  ]);
  store.setReviewBody(comment.body!);

  await submitReview(store, github, "COMMENT");
  expect(store.getSnapshot().overviewScrollTarget).toBe("issuecomment-73");
  expect(buildOverviewTimeline(store.getSnapshot()).navigationIds).toContain(
    "issuecomment-73"
  );
  conversation.resolve([]);
  await reconciled();
  expect(store.getSnapshot().conversation[0]?.body).toBe(comment.body);
  store.setConversation([comment]);
  expect(store.getSnapshot().conversation).toHaveLength(1);
});

test("a failed reconciliation does not fail an accepted review or restore its draft", async () => {
  const { store, github, reconciled } = setup();
  const error = spyOn(console, "error").mockImplementation(() => {});
  github.createPRReview = async () =>
    ({
      id: 90,
      state: "APPROVED",
      body: "Looks good",
      submitted_at: "2026-01-02",
    }) as Review;
  github.getPRReviews = async () => {
    throw new Error("list unavailable");
  };
  store.setReviewBody("Looks good");
  try {
    await submitReview(store, github, "APPROVE");
    await reconciled();
    expect(store.getSnapshot().reviews[0]?.body).toBe("Looks good");
    expect(store.getSnapshot().overviewScrollTarget).toBe(
      "pullrequestreview-90"
    );
    expect(store.getSnapshot().reviewBody).toBe("");
    expect(error).toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

test("recovered GraphQL submissions retain the server's summary body", async () => {
  const { store, github, reconciled } = setup();
  store.setPendingReviewNodeId("review-node");
  store.setReviewBody("Local fallback");
  github.getReview = async () => ({
    id: "review-node",
    databaseId: 42,
    state: "COMMENTED",
    submittedAt: "2026-01-02",
    viewerDidAuthor: true,
    body: "Already accepted summary",
  });
  await submitReview(store, github, "COMMENT");
  await reconciled();
  expect(store.getSnapshot().reviews[0]?.body).toBe("Already accepted summary");
  expect(buildOverviewTimeline(store.getSnapshot()).navigationIds).toContain(
    "pullrequestreview-42"
  );
});

test("out-of-diff comments are visible and use a stable comment target before list endpoints catch up", async () => {
  const { store, github, reconciled } = setup();
  github.getPRFiles = async () =>
    [{ filename: "a.ts", patch: "@@ -1 +1 @@\n-old\n+new" }] as Awaited<
      ReturnType<GitHubStore["getPRFiles"]>
    >;
  github.createFileLevelComment = async (_owner, _repo, _number, options) =>
    ({
      id: 55,
      node_id: "file-comment",
      body: options.body,
      path: options.path,
      pull_request_review_id: 91,
      user: { login: "reviewer", avatar_url: "" },
      created_at: "2026-01-02",
      updated_at: "2026-01-02",
      commit_id: "head",
      original_commit_id: "head",
    }) as Awaited<ReturnType<GitHubStore["createFileLevelComment"]>>;
  store.setPendingComments([
    {
      id: "outside",
      path: "a.ts",
      line: 99,
      body: "Outside the diff",
      side: "RIGHT",
    },
  ]);
  await submitReview(store, github, "COMMENT");
  await reconciled();
  expect(store.getSnapshot().overviewScrollTarget).toBe("discussion_r55");
  expect(store.getSnapshot().comments[0]?.body).toContain("Outside the diff");
  const card = buildOverviewTimeline(store.getSnapshot()).entries.find(
    (entry) => entry.type === "review"
  );
  expect(
    card?.type === "review" && card.threads[0]?.comments.nodes[0]?.databaseId
  ).toBe(55);
});

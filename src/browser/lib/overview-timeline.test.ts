import { expect, test } from "bun:test";
import { buildOverviewTimeline } from "./overview-timeline";
import { reviewGroupMarker } from "../../shared/review-group";
import type {
  PullRequest,
  Review,
  ReviewThread,
  TimelineEvent,
} from "../contexts/github";

const input = () => ({
  pr: {
    merged: true,
    created_at: "2026-01-01",
    user: { login: "author" },
  } as PullRequest,
  timeline: [] as TimelineEvent[],
  conversation: [],
  reviews: [] as Review[],
  reviewThreads: [] as ReviewThread[],
  pushVersions: [],
  commitsByVersion: [],
});
const reviewed = (id: number) => ({ event: "reviewed", id }) as TimelineEvent;
const thread = (id: string, reviewId?: number, body = "comment") =>
  ({
    id,
    pullRequestReview: reviewId ? { databaseId: reviewId } : null,
    comments: { nodes: [{ body }] },
  }) as ReviewThread;

test("navigation contains exactly the visible review cards and nonempty threads", () => {
  const data = input();
  data.reviews = [
    { id: 1, body: "  ", state: "COMMENTED" },
    { id: 2, body: "", state: "APPROVED" },
    { id: 3, body: "", state: "COMMENTED" },
  ] as Review[];
  data.timeline = [
    reviewed(1),
    reviewed(2),
    reviewed(3),
    { event: "closed" } as TimelineEvent,
  ];
  data.reviewThreads = [
    thread("inline", 3),
    thread("orphan"),
    { ...thread("empty"), comments: { nodes: [] } },
  ];
  const result = buildOverviewTimeline(data);
  expect(result.navigationIds).toEqual([
    "pr-description",
    "pullrequestreview-2",
    "pullrequestreview-3",
    "reviewthread-inline",
    "reviewthread-orphan",
  ]);
  expect(result.entries.map((entry) => entry.type)).toEqual([
    "review",
    "review",
    "thread",
  ]);
});

test("grouped review submissions produce one card with all member threads", () => {
  const data = input();
  data.reviews = [
    { id: 1, body: "", state: "COMMENTED" },
    { id: 2, body: "", state: "COMMENTED" },
  ] as Review[];
  data.timeline = [reviewed(2), reviewed(1)];
  data.reviewThreads = [
    thread("a", 1, reviewGroupMarker("g", 0, 2)),
    thread("b", 2, reviewGroupMarker("g", 1, 2)),
  ];
  const result = buildOverviewTimeline(data);
  expect(result.entries).toHaveLength(1);
  expect(result.navigationIds).toEqual([
    "pr-description",
    "pullrequestreview-1",
    "reviewthread-a",
    "reviewthread-b",
  ]);
});

test("synthetic pushes use API timestamps and do not duplicate force pushes", () => {
  const data = {
    ...input(),
    timeline: [
      { event: "renamed", created_at: "2026-01-03" },
      {
        event: "head_ref_force_pushed",
        commit_id: "v3",
        created_at: "2026-01-04",
      },
    ] as TimelineEvent[],
    pushVersions: [1, 2, 3].map((version) => ({
      version,
      sha: `v${version}`,
      pushedAt: `2026-01-0${version}`,
    })),
  };
  const result = buildOverviewTimeline(data);
  expect(
    result.entries.map((entry) =>
      entry.type === "version_event"
        ? (entry.event as { commit_id?: string }).commit_id
        : entry.type
    )
  ).toEqual(["v1", "v2", "event", "v3"]);
});

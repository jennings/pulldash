import type {
  IssueComment,
  PRCommit,
  PullRequest,
  PushVersion,
  Review,
  ReviewThread,
  TimelineEvent,
} from "../contexts/github";
import {
  parseReviewGroupMarker,
  reviewGroups,
  type MarkedReview,
} from "../../shared/review-group";

export type OverviewTimelineEntry =
  | { type: "comment"; data: IssueComment }
  | { type: "review"; data: Review; threads: ReviewThread[] }
  | { type: "thread"; data: ReviewThread }
  | { type: "event"; data: TimelineEvent }
  | { type: "version_event"; event: TimelineEvent; commits: PRCommit[] };

function timestamp(entry: OverviewTimelineEntry) {
  const value =
    entry.type === "review"
      ? entry.data.submitted_at
      : entry.type === "thread"
        ? entry.data.comments.nodes[0]?.createdAt
        : (
            (entry.type === "version_event" ? entry.event : entry.data) as {
              created_at?: string;
            }
          ).created_at;
  return value ? new Date(value).getTime() : null;
}

export function buildOverviewTimeline({
  pr,
  timeline,
  conversation,
  reviews,
  reviewThreads,
  pushVersions,
  commitsByVersion,
}: {
  pr: PullRequest;
  timeline: TimelineEvent[];
  conversation: IssueComment[];
  reviews: Review[];
  reviewThreads: ReviewThread[];
  pushVersions: PushVersion[];
  commitsByVersion: Array<{ version: number; commits: PRCommit[] }>;
}) {
  const entries: OverviewTimelineEntry[] = [];
  const threadsByReview = new Map<number, ReviewThread[]>();
  const orphans: ReviewThread[] = [];
  for (const thread of reviewThreads) {
    const id = thread.pullRequestReview?.databaseId;
    if (id)
      threadsByReview.set(id, [...(threadsByReview.get(id) ?? []), thread]);
    else orphans.push(thread);
  }
  const marked: MarkedReview[] = [];
  for (const review of reviews) {
    for (const thread of threadsByReview.get(review.id) ?? []) {
      const info = parseReviewGroupMarker(thread.comments.nodes[0]?.body ?? "");
      if (info) {
        marked.push({ reviewId: review.id, info });
        break;
      }
    }
  }
  const { memberToPrimary, primaryToMembers } = reviewGroups(marked);
  const commentsById = new Map(conversation.map((c) => [c.id, c]));
  const reviewsById = new Map(reviews.map((r) => [r.id, r]));
  const versionCommits = new Map(
    commitsByVersion.map((v) => [v.version, v.commits])
  );
  if (pushVersions[0]?.version === 1) {
    entries.push({
      type: "version_event",
      event: {
        id: -1,
        event: "opened",
        actor: pr.user,
        created_at: pr.created_at,
        commit_id: pushVersions[0].sha,
      } as TimelineEvent,
      commits: versionCommits.get(1) ?? [],
    });
  }
  for (const event of timeline) {
    if (!("event" in event)) continue;
    if (event.event === "closed" && pr.merged) continue;
    if (event.event === "commented" && "id" in event) {
      const comment = commentsById.get(Number(event.id));
      if (comment) entries.push({ type: "comment", data: comment });
    } else if (event.event === "reviewed" && "id" in event) {
      const review = reviewsById.get(Number(event.id));
      if (
        !review ||
        (memberToPrimary.get(review.id) ?? review.id) !== review.id
      )
        continue;
      const members = primaryToMembers
        .get(review.id)
        ?.map((m) => m.reviewId) ?? [review.id];
      const threads = members
        .flatMap((id) => threadsByReview.get(id) ?? [])
        .filter((t) => t.comments.nodes.length > 0);
      if (
        review.body?.trim() ||
        review.state === "APPROVED" ||
        review.state === "CHANGES_REQUESTED" ||
        threads.length
      ) {
        entries.push({ type: "review", data: review, threads });
      }
    } else if (event.event === "head_ref_force_pushed") {
      const sha = (event as { commit_id?: string }).commit_id;
      const version = pushVersions.find((v) => v.sha === sha);
      entries.push({
        type: "version_event",
        event,
        commits: version ? (versionCommits.get(version.version) ?? []) : [],
      });
    } else if (event.event !== "line-commented") {
      entries.push({ type: "event", data: event });
    }
  }
  const forcePushed = new Set(
    timeline.flatMap((event) =>
      "event" in event && event.event === "head_ref_force_pushed"
        ? [(event as { commit_id?: string }).commit_id]
        : []
    )
  );
  for (let i = 1; i < pushVersions.length; i++) {
    const from = pushVersions[i - 1]!;
    const to = pushVersions[i]!;
    if (forcePushed.has(to.sha)) continue;
    const previous = new Set(
      (versionCommits.get(from.version) ?? []).map((c) => c.sha)
    );
    const commits = (versionCommits.get(to.version) ?? []).filter(
      (c) => !previous.has(c.sha)
    );
    const entry: OverviewTimelineEntry = {
      type: "version_event",
      commits,
      event: {
        id: -i,
        event: "head_ref_normal_pushed",
        actor: commits.at(-1)?.author ?? pr.user,
        created_at: to.pushedAt,
        commit_id: to.sha,
        from_sha: from.sha,
        from_version: from.version,
        to_version: to.version,
      } as TimelineEvent,
    };
    const previousIndex = entries.findIndex(
      (e) =>
        e.type === "version_event" &&
        (e.event as { commit_id?: string }).commit_id === from.sha
    );
    let index = entries.length;
    if (previousIndex !== -1) {
      const pushTime = new Date(to.pushedAt).getTime();
      for (let j = previousIndex + 1; j < entries.length; j++) {
        const candidate = entries[j]!;
        if (
          candidate.type === "version_event" ||
          (timestamp(candidate) ?? 0) > pushTime
        ) {
          index = j;
          break;
        }
      }
    }
    entries.splice(index, 0, entry);
  }
  for (const thread of orphans) {
    if (thread.comments.nodes.length)
      entries.push({ type: "thread", data: thread });
  }
  const navigationIds = [
    "pr-description",
    ...entries.flatMap((entry) => {
      if (entry.type === "comment") return [`issuecomment-${entry.data.id}`];
      if (entry.type === "review")
        return [
          `pullrequestreview-${entry.data.id}`,
          ...entry.threads.map((t) => `reviewthread-${t.id}`),
        ];
      if (entry.type === "thread") return [`reviewthread-${entry.data.id}`];
      return [];
    }),
  ];
  return { entries, navigationIds };
}

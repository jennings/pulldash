import type { IssueComment, Review, ReviewComment } from "@/api/types";
import type { ReviewThread, TimelineEvent } from "../contexts/github";
import {
  isMetadataComment,
  parseCommitMetadataMarker,
} from "@/shared/commit-metadata";
import { submittedCommentKey } from "./review-submit";

export interface SubmittedActivity {
  reviews?: Review[];
  conversation?: IssueComment[];
  comments?: ReviewComment[];
  threads?: ReviewThread[];
}

class ConfirmedItems<T extends { id: number }> {
  private pending = new Map<number, T>();

  add(items: T[] = []) {
    for (const item of items) this.pending.set(item.id, item);
  }

  updateLocal(items: T[]) {
    if (!this.pending.size) return;
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const id of this.pending.keys()) {
      const item = byId.get(id);
      if (item) this.pending.set(id, item);
      else this.pending.delete(id);
    }
  }

  merge(
    items: T[],
    acknowledge = true,
    isReady = (_item: T, _confirmed: T) => true
  ): T[] {
    if (!this.pending.size) return items;
    const merged = new Map(items.map((item) => [item.id, item]));
    for (const [id, item] of this.pending) {
      const fetched = merged.get(id);
      if (acknowledge && fetched && isReady(fetched, item))
        this.pending.delete(id);
      else merged.set(id, item);
    }
    return [...merged.values()];
  }
}

function eventKey(event: TimelineEvent) {
  return "event" in event && "id" in event
    ? `${event.event}:${event.id}`
    : null;
}

function threadCommentKey(
  thread: ReviewThread,
  comment: ReviewThread["comments"]["nodes"][number]
) {
  const metadata = isMetadataComment(comment.body)
    ? parseCommitMetadataMarker(comment.body)
    : null;
  return `${thread.pullRequestReview?.databaseId ?? ""}:${submittedCommentKey(
    metadata ? ":commit" : comment.path,
    metadata?.line ?? comment.line,
    comment.startLine,
    comment.body
  )}`;
}

/** Keep accepted mutations visible until each independent list endpoint catches up. */
export class SubmittedActivityBuffer {
  private reviews = new ConfirmedItems<Review>();
  private conversation = new ConfirmedItems<IssueComment>();
  private comments = new ConfirmedItems<ReviewComment>();
  private timeline = new Map<string, TimelineEvent>();
  private threads = new Map<string, ReviewThread>();

  updateLocalComments(comments: ReviewComment[], threads: ReviewThread[]) {
    this.comments.updateLocal(comments);
    if (!this.threads.size) return;
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    for (const id of this.threads.keys()) {
      const thread = byId.get(id);
      if (thread) this.threads.set(id, thread);
      else this.threads.delete(id);
    }
  }

  add(activity: SubmittedActivity) {
    this.reviews.add(activity.reviews);
    this.conversation.add(activity.conversation);
    this.comments.add(activity.comments);
    for (const review of activity.reviews ?? []) {
      const event = {
        id: review.id,
        event: "reviewed",
        actor: review.user,
        created_at: review.submitted_at ?? new Date().toISOString(),
      } as TimelineEvent;
      this.timeline.set(eventKey(event)!, event);
    }
    for (const comment of activity.conversation ?? []) {
      const event = {
        ...comment,
        event: "commented",
        actor: comment.user,
      } as TimelineEvent;
      this.timeline.set(eventKey(event)!, event);
    }
    for (const thread of activity.threads ?? [])
      this.threads.set(thread.id, thread);
  }

  mergeReviews = (items: Review[], acknowledge = true) =>
    this.reviews.merge(
      items,
      acknowledge,
      (review, confirmed) =>
        review.state !== "PENDING" &&
        (!confirmed.body?.trim() || !!review.body?.trim())
    );
  mergeConversation = (items: IssueComment[], acknowledge = true) =>
    this.conversation.merge(items, acknowledge);
  mergeComments = (items: ReviewComment[], acknowledge = true) =>
    this.comments.merge(items, acknowledge);

  mergeTimeline(items: TimelineEvent[], acknowledge = true) {
    if (!this.timeline.size) return items;
    const known = new Set(items.map(eventKey));
    const result = [...items];
    for (const [key, event] of this.timeline) {
      if (known.has(key)) {
        if (acknowledge) this.timeline.delete(key);
      } else result.push(event);
    }
    return result;
  }

  mergeThreads(items: ReviewThread[], acknowledge = true) {
    if (!this.threads.size) return items;
    const ids = new Set(items.map((thread) => thread.id));
    const commentIds = new Set(
      items.flatMap((thread) =>
        thread.comments.nodes.map((comment) => comment.databaseId)
      )
    );
    const keys = new Set(
      items.flatMap((thread) =>
        thread.comments.nodes.map((comment) =>
          threadCommentKey(thread, comment)
        )
      )
    );
    const result = [...items];
    for (const [id, thread] of this.threads) {
      const known =
        ids.has(id) ||
        thread.comments.nodes.every((comment) =>
          comment.databaseId
            ? commentIds.has(comment.databaseId)
            : keys.has(threadCommentKey(thread, comment))
        );
      if (known) {
        if (acknowledge) this.threads.delete(id);
      } else result.push(thread);
    }
    return result;
  }
}

import { useImperativeHandle, useState, type Ref, type RefObject } from "react";
import { GitPullRequest, Loader2 } from "lucide-react";
import {
  useCurrentUser,
  useGitHub,
  type TimelineEvent,
} from "../contexts/github";
import { usePRReviewSelector, usePRReviewStore } from "../contexts/pr-review";
import { MarkdownEditor } from "../ui/markdown";

export interface OverviewComposerHandle {
  setText: (text: string) => void;
  submit: () => Promise<void>;
}

export function OverviewComposer({
  ref,
  draft,
  canClose,
}: {
  ref: Ref<OverviewComposerHandle>;
  draft: RefObject<string>;
  canClose: boolean;
}) {
  const github = useGitHub();
  const store = usePRReviewStore();
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const pr = usePRReviewSelector((s) => s.pr);
  const closing = usePRReviewSelector((s) => s.closingPR);
  const currentUser = useCurrentUser()?.login;
  const [text, setTextState] = useState(draft.current);
  const [submitting, setSubmitting] = useState(false);
  const setText = (value: string) => {
    draft.current = value;
    setTextState(value);
  };
  const submit = async () => {
    const body = draft.current;
    if (!body.trim() || submitting) return;
    setSubmitting(true);
    try {
      const comment = await github.createPRConversationComment(
        owner,
        repo,
        pr.number,
        body
      );
      store.addConversationComment(comment);
      store.addTimelineEvent({
        ...comment,
        event: "commented",
        actor: comment.user!,
      } as TimelineEvent);
      github.invalidatePR(owner, repo, pr.number);
      if (draft.current === body) setText("");
    } catch (error) {
      console.error("Failed to add comment:", error);
    } finally {
      setSubmitting(false);
    }
  };
  useImperativeHandle(ref, () => ({ setText, submit }));
  return (
    <div id="conversation-comment-box" className="flex gap-3">
      {currentUser && (
        <img
          src={`https://avatars.githubusercontent.com/${currentUser}`}
          alt={currentUser}
          className="hidden sm:block w-10 h-10 rounded-full shrink-0"
        />
      )}
      <div className="flex-1 flex flex-col gap-2">
        <MarkdownEditor
          value={text}
          onChange={setText}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Add your comment here..."
          minHeight="100px"
        />
        <div className="flex items-center justify-end gap-2">
          {canClose && pr.state === "open" && !pr.merged && (
            <button
              onClick={async () => {
                await submit();
                await store.closePR();
              }}
              disabled={closing || submitting}
              className="flex items-center gap-2 px-3 py-1.5 border border-red-500/50 text-red-400 rounded-md hover:bg-red-500/10 transition-colors text-sm font-medium disabled:opacity-50"
            >
              {closing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <GitPullRequest className="w-4 h-4" />
              )}
              {closing ? "Closing..." : "Close pull request"}
            </button>
          )}
          <button
            onClick={submit}
            disabled={!text.trim() || submitting}
            className="flex items-center gap-2 px-3 py-1.5 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors disabled:opacity-50 text-sm font-medium"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}Comment
          </button>
        </div>
      </div>
    </div>
  );
}

import { useGitHub } from "@/browser/contexts/github";
import { usePRReviewStore } from ".";

export function useThreadActions() {
  const store = usePRReviewStore();
  const github = useGitHub();

  const resolveThread = async (threadId: string) => {
    try {
      await github.resolveThread(threadId);
      store.updateReviewThread(threadId, (t) => ({ ...t, isResolved: true }));
    } catch (error) {
      console.error("Failed to resolve thread:", error);
    }
  };

  const unresolveThread = async (threadId: string) => {
    try {
      await github.unresolveThread(threadId);
      store.updateReviewThread(threadId, (t) => ({ ...t, isResolved: false }));
    } catch (error) {
      console.error("Failed to unresolve thread:", error);
    }
  };

  return { resolveThread, unresolveThread };
}

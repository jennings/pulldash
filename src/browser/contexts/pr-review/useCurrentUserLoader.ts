import { useEffect } from "react";
import { useGitHubSelector, useCurrentUser } from "@/browser/contexts/github";
import { usePRReviewStore } from ".";

export function useCurrentUserLoader() {
  const store = usePRReviewStore();
  const ready = useGitHubSelector((s) => s.ready);
  const currentUser = useCurrentUser();

  useEffect(() => {
    if (ready && currentUser) {
      store.setCurrentUser(currentUser.login);
    }
  }, [ready, currentUser, store]);
}

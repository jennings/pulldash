import { useCallback, useEffect, useRef, useState } from "react";
import { DraftBuffer } from "../lib/draft-buffer";

export function useDraft(saved: string, commit: (value: string) => void) {
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const [draft] = useState(
    () => new DraftBuffer(saved, (value) => commitRef.current(value))
  );
  const [value, setValue] = useState(saved);

  useEffect(() => {
    if (saved === draft.committed) return;
    draft.reset(saved);
    setValue(saved);
  }, [saved, draft]);

  useEffect(() => {
    window.addEventListener("pagehide", draft.flush);
    const onVisibility = () => {
      if (document.hidden) draft.flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", draft.flush);
      document.removeEventListener("visibilitychange", onVisibility);
      draft.flush();
    };
  }, [draft]);

  const update = useCallback(
    (next: string) => {
      draft.update(next);
      setValue(next);
    },
    [draft]
  );
  return [value, update, draft.flush] as const;
}

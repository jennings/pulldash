/** The repository's choices for prefilled merge commit messages. */
export interface MergeMessageSettings {
  mergeTitle: "MERGE_MESSAGE" | "PR_TITLE";
  mergeMessage: "PR_TITLE" | "PR_BODY" | "BLANK";
  squashTitle: "PR_TITLE" | "COMMIT_OR_PR_TITLE";
  squashMessage: "PR_BODY" | "COMMIT_MESSAGES" | "BLANK";
}

/** GitHub's own defaults, for repositories that never changed them. */
export const DEFAULT_MERGE_MESSAGE_SETTINGS: MergeMessageSettings = {
  mergeTitle: "MERGE_MESSAGE",
  mergeMessage: "PR_TITLE",
  squashTitle: "COMMIT_OR_PR_TITLE",
  squashMessage: "COMMIT_MESSAGES",
};

interface PRLike {
  number: number;
  title: string;
  body?: string | null;
  head: { label: string };
}

/** The commit title and message GitHub prefills when merging `pr`. */
export function defaultMergeMessage(
  method: "merge" | "squash",
  settings: MergeMessageSettings,
  pr: PRLike,
  commits: Array<{ commit: { message: string } }>
): { title: string; message: string } {
  const prTitle = `${pr.title} (#${pr.number})`;
  const body = pr.body ?? "";
  if (method === "merge")
    return {
      title:
        settings.mergeTitle === "PR_TITLE"
          ? prTitle
          : `Merge pull request #${pr.number} from ${pr.head.label.replace(":", "/")}`,
      message: { PR_TITLE: pr.title, PR_BODY: body, BLANK: "" }[
        settings.mergeMessage
      ],
    };
  const only = commits.length === 1 ? commits[0]!.commit.message : null;
  return {
    title:
      settings.squashTitle === "COMMIT_OR_PR_TITLE" && only
        ? `${only.split("\n")[0]} (#${pr.number})`
        : prTitle,
    message: {
      PR_BODY: body,
      // A single commit gives its body, as its subject is the title.
      COMMIT_MESSAGES: only
        ? only.split("\n").slice(1).join("\n").trim()
        : commits.map((c) => `* ${c.commit.message}`).join("\n\n"),
      BLANK: "",
    }[settings.squashMessage],
  };
}

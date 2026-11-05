import { useState } from "react";
import { CircleQuestionMark } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

// Qualifiers from GitHub's issue/PR search docs that are meaningful for the
// home PR list. Omits issue-only qualifiers and ones the filters already set
// (`is:pr`, `archived:false`, open/closed state) or that the list overrides
// (`sort:`).
// https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests

interface Operator {
  syntax: string;
  description: string;
}

interface OperatorSection {
  title: string;
  operators: Operator[];
}

const SECTIONS: OperatorSection[] = [
  {
    title: "Text & syntax",
    operators: [
      { syntax: "fix crash", description: "Words in title, body, or comments" },
      { syntax: '"exact phrase"', description: "Match a multi-word phrase" },
      { syntax: "in:title", description: "Only match words in the title" },
      { syntax: "in:body", description: "Only match words in the body" },
      { syntax: "in:comments", description: "Only match words in comments" },
      { syntax: "-label:wip", description: "Exclude anything matching" },
      { syntax: "e1109ab", description: "Contains a commit SHA (7+ chars)" },
    ],
  },
  {
    title: "Location",
    operators: [
      { syntax: "repo:owner/name", description: "In a repository" },
      { syntax: "org:name", description: "In an organization's repos" },
      { syntax: "user:name", description: "In a user's repos" },
      { syntax: "language:go", description: "In repos written in a language" },
      { syntax: "is:public", description: "In public repos (or is:private)" },
    ],
  },
  {
    title: "People",
    operators: [
      { syntax: "author:@me", description: "Opened by you (or a username)" },
      { syntax: "author:app/name", description: "Opened by an app or bot" },
      { syntax: "assignee:user", description: "Assigned to a user" },
      { syntax: "mentions:user", description: "Mentions a user" },
      { syntax: "team:org/team", description: "Mentions a team" },
      { syntax: "commenter:user", description: "Has a comment by a user" },
      {
        syntax: "involves:user",
        description: "Author, assignee, mention, or commenter",
      },
    ],
  },
  {
    title: "Reviews",
    operators: [
      { syntax: "review:none", description: "Not reviewed yet" },
      { syntax: "review:required", description: "Needs a review to merge" },
      { syntax: "review:approved", description: "Approved by a reviewer" },
      {
        syntax: "review:changes_requested",
        description: "A reviewer requested changes",
      },
      { syntax: "reviewed-by:user", description: "Reviewed by a user" },
      {
        syntax: "review-requested:user",
        description: "User or their team is requested",
      },
      {
        syntax: "user-review-requested:@me",
        description: "You're requested directly",
      },
      {
        syntax: "team-review-requested:org/team",
        description: "A team is requested",
      },
      {
        syntax: "review-involves:user",
        description: "Requested or already reviewed",
      },
    ],
  },
  {
    title: "Status",
    operators: [
      { syntax: "is:draft", description: "Draft PRs (-is:draft to hide)" },
      { syntax: "is:merged", description: "Merged PRs" },
      { syntax: "is:unmerged", description: "Open or closed without merging" },
      { syntax: "is:queued", description: "In the merge queue" },
      { syntax: "is:locked", description: "Conversation is locked" },
      { syntax: "status:success", description: "All commit statuses passed" },
      { syntax: "status:failure", description: "A status errored or failed" },
      { syntax: "status:pending", description: "No statuses, or one pending" },
      { syntax: "linked:issue", description: "Linked to an issue it closes" },
    ],
  },
  {
    title: "Branches & metadata",
    operators: [
      { syntax: "head:feature", description: "Head branch starts with" },
      { syntax: "base:main", description: "Merging into a branch" },
      { syntax: 'label:"help wanted"', description: "Has a label" },
      {
        syntax: "label:bug,wip",
        description: "Has either label (repeat for both)",
      },
      { syntax: 'milestone:"v2"', description: "In a milestone" },
      { syntax: "project:org/57", description: "In a project by number" },
      {
        syntax: "no:label",
        description: "Missing labels (or milestone, assignee, project)",
      },
    ],
  },
  {
    title: "Dates & counts",
    operators: [
      { syntax: "created:>2026-01-01", description: "Opened after a date" },
      { syntax: "updated:<2026-01-01", description: "Last updated before" },
      {
        syntax: "merged:2026-01-01..2026-01-31",
        description: "Merged within a range",
      },
      { syntax: "closed:>=2026-01-01", description: "Closed on or after" },
      { syntax: "comments:>10", description: "More than 10 comments" },
      { syntax: "reactions:>5", description: "More than 5 reactions" },
      {
        syntax: "interactions:10..50",
        description: "Comments + reactions in a range",
      },
    ],
  },
];

export function SearchHelpButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        aria-label="Search syntax help"
        title="Search syntax help"
      >
        <CircleQuestionMark className="w-3.5 h-3.5" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Search operators</DialogTitle>
            <DialogDescription>
              Your search is added to each filter's query, so these narrow the
              current list. Combine as many as you like; dates use YYYY-MM-DD
              with <code className="font-mono">&gt;</code>,{" "}
              <code className="font-mono">&lt;=</code>, or{" "}
              <code className="font-mono">a..b</code> ranges.{" "}
              <a
                href="https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Full GitHub reference
              </a>
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5 text-sm">
            {SECTIONS.map((section) => (
              <section key={section.title}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  {section.title}
                </h3>
                <ul className="space-y-1.5">
                  {section.operators.map((op) => (
                    <li
                      key={op.syntax}
                      className="flex items-baseline justify-between gap-3"
                    >
                      <code className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted text-foreground whitespace-nowrap">
                        {op.syntax}
                      </code>
                      <span className="text-xs text-muted-foreground text-right">
                        {op.description}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

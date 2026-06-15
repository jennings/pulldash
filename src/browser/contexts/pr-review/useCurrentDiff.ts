import { useMemo } from "react";
import {
  usePRReviewSelector,
  type ParsedDiff,
  type DiffLine,
  type DiffHunk,
} from ".";
import type { PRCommit } from "@/browser/contexts/github";
import { buildInlineDiffSegments, escapeHtml } from "@/shared/diff-utils";
import { INLINE_MAX_CHAR_EDITS } from "@/diff-parse-constants";

const EMPTY_DIFF: ParsedDiff = { hunks: [] };
const SEPARATOR = "\u2500".repeat(50);

const COMMIT_FILE = ":commit";

interface CommitField {
  label: string;
  value: string;
  kind: "sha" | "user" | "date";
  muted?: string;
}

const VALUE_COLORS: Record<CommitField["kind"], string> = {
  sha: "color:oklch(0.65 0.18 255)",
  user: "color:oklch(0.67 0.15 160)",
  date: "color:oklch(0.7 0.12 85)",
};

interface MetadataLine {
  raw: string;
  html: string;
}

function getCommitFields(commit: PRCommit): CommitField[] {
  const fields: CommitField[] = [];
  const author = commit.commit.author;
  const authorName = author?.name ?? "Unknown";
  const authorEmail = author?.email ?? "unknown";

  fields.push({ label: "Commit", value: commit.sha, kind: "sha" });
  if (commit.parents && commit.parents.length > 0) {
    const parentValue = commit.parents.map((p) => p.sha).join(", ");
    fields.push({ label: "Parents", value: parentValue, kind: "sha" });
  }
  fields.push({
    label: "Author",
    value: authorName,
    kind: "user",
    muted: `<${authorEmail}>`,
  });
  if (author?.date) {
    fields.push({
      label: "Date",
      value: new Date(author.date).toLocaleString(),
      kind: "date",
    });
  }

  const committer = commit.commit.committer;
  if (committer) {
    fields.push({
      label: "Committer",
      value: committer.name ?? "Unknown",
      kind: "user",
      muted: `<${committer.email ?? "unknown"}>`,
    });
    if (committer.date) {
      fields.push({
        label: "Committed",
        value: new Date(committer.date).toLocaleString(),
        kind: "date",
      });
    }
  }

  return fields;
}

function fieldHtml(field: CommitField): string {
  let valueHtml = `<span style="${VALUE_COLORS[field.kind]}">${escapeHtml(field.value)}</span>`;
  if (field.muted !== undefined) {
    valueHtml += `<span style="color:var(--muted-foreground)"> ${escapeHtml(field.muted)}</span>`;
  }
  return `<span style="color:var(--muted-foreground);font-weight:500">${escapeHtml(field.label)}:</span> ${valueHtml}`;
}

function buildMetadataLines(commit: PRCommit): MetadataLine[] {
  const lines: MetadataLine[] = [];
  const fields = getCommitFields(commit);

  for (const f of fields) {
    lines.push({
      raw: `${f.label}: ${f.value}${f.muted !== undefined ? ` ${f.muted}` : ""}`,
      html: fieldHtml(f),
    });
  }

  const sepRaw = SEPARATOR;
  const sepHtml = `<span style="color:var(--muted-foreground);opacity:0.4">${SEPARATOR}</span>`;
  lines.push({ raw: sepRaw, html: sepHtml });

  for (const line of commit.commit.message.split("\n")) {
    lines.push({ raw: line, html: escapeHtml(line) });
  }

  if (commit.stats) {
    const parts: string[] = [];
    if (commit.stats.additions !== undefined)
      parts.push(`+${commit.stats.additions}`);
    if (commit.stats.deletions !== undefined)
      parts.push(`-${commit.stats.deletions}`);
    if (commit.stats.total !== undefined)
      parts.push(
        `${commit.stats.total} file${commit.stats.total !== 1 ? "s" : ""}`
      );
    if (parts.length > 0) {
      lines.push({ raw: sepRaw, html: sepHtml });

      const statsText = parts.join("  ");
      lines.push({ raw: statsText, html: statsText });
    }
  }

  return lines;
}

function makeContent(html: string, text: string): DiffLine["content"] {
  return [{ value: text, html, type: "normal" }];
}

function buildSingleCommitDiff(commit: PRCommit): ParsedDiff {
  const metadataLines = buildMetadataLines(commit);
  const diffLines: DiffLine[] = metadataLines.map((ml, i) => ({
    type: "normal",
    oldLineNumber: i + 1,
    newLineNumber: i + 1,
    content: makeContent(ml.html, ml.raw),
  }));
  const hunk: DiffHunk = {
    type: "hunk",
    oldStart: 1,
    newStart: 1,
    lines: diffLines,
  };
  return { hunks: [hunk] };
}

function buildInterdiff(
  prevCommit: PRCommit,
  headCommit: PRCommit
): ParsedDiff {
  const prevLines = buildMetadataLines(prevCommit);
  const headLines = buildMetadataLines(headCommit);
  const maxLen = Math.max(prevLines.length, headLines.length);
  let oldNum = 0;
  let newNum = 0;
  const result: DiffLine[] = [];

  for (let i = 0; i < maxLen; i++) {
    const prev = prevLines[i];
    const head = headLines[i];

    if (prev && head && prev.raw === head.raw) {
      oldNum++;
      newNum++;
      result.push({
        type: "normal",
        oldLineNumber: oldNum,
        newLineNumber: newNum,
        content: makeContent(head.html, head.raw),
      });
    } else {
      if (prev && head) {
        const segments = buildInlineDiffSegments(
          prev.raw,
          head.raw,
          INLINE_MAX_CHAR_EDITS
        );
        oldNum++;
        result.push({
          type: "delete",
          oldLineNumber: oldNum,
          newLineNumber: undefined,
          content: segments
            .filter((s) => s.type !== "insert")
            .map((s) => ({
              value: s.value,
              html: escapeHtml(s.value),
              type: s.type as "insert" | "delete" | "normal",
            })),
        });
        newNum++;
        result.push({
          type: "insert",
          oldLineNumber: undefined,
          newLineNumber: newNum,
          content: segments
            .filter((s) => s.type !== "delete")
            .map((s) => ({
              value: s.value,
              html: escapeHtml(s.value),
              type: s.type === "delete" ? ("normal" as const) : s.type,
            })),
        });
      } else if (prev) {
        oldNum++;
        result.push({
          type: "delete",
          oldLineNumber: oldNum,
          newLineNumber: undefined,
          content: makeContent(prev.html, prev.raw),
        });
      } else if (head) {
        newNum++;
        result.push({
          type: "insert",
          oldLineNumber: undefined,
          newLineNumber: newNum,
          content: makeContent(head.html, head.raw),
        });
      }
    }
  }

  const hunk: DiffHunk = {
    type: "hunk",
    oldStart: 1,
    newStart: 1,
    lines: result,
  };
  return { hunks: [hunk] };
}

function findCommitBySha(
  sha: string,
  mainCommits: PRCommit[],
  commitsByVersion: Array<{ version: number; commits: PRCommit[] }>
): PRCommit | undefined {
  const inMain = mainCommits.find((c) => c.sha === sha);
  if (inMain) return inMain;
  for (const vc of commitsByVersion) {
    const found = vc.commits.find((c) => c.sha === sha);
    if (found) return found;
  }
  return undefined;
}

export function useCurrentDiff(): ParsedDiff | null {
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const loadedDiffs = usePRReviewSelector((s) => s.loadedDiffs);
  const interdiffEnabled = usePRReviewSelector((s) => s.interdiffEnabled);
  const interdiffLoadedDiffs = usePRReviewSelector(
    (s) => s.interdiffLoadedDiffs
  );
  const versionCompareNoChangeFiles = usePRReviewSelector(
    (s) => s.versionCompareNoChangeFiles
  );
  const commits = usePRReviewSelector((s) => s.commits);
  const selectedCommitSha = usePRReviewSelector((s) => s.selectedCommitSha);
  const compareToCommitSha = usePRReviewSelector((s) => s.compareToCommitSha);
  const compareToSha = usePRReviewSelector((s) => s.compareToSha);
  const commitsByVersion = usePRReviewSelector((s) => s.commitsByVersion);
  return useMemo(() => {
    if (!selectedFile) return null;
    if (versionCompareNoChangeFiles.includes(selectedFile)) return EMPTY_DIFF;
    if (selectedFile === COMMIT_FILE && selectedCommitSha) {
      const headCommit = commits.find((c) => c.sha === selectedCommitSha);
      if (!headCommit) return null;
      if (interdiffEnabled && compareToCommitSha) {
        const prevCommit = findCommitBySha(
          compareToCommitSha,
          commits,
          commitsByVersion
        );
        if (prevCommit) return buildInterdiff(prevCommit, headCommit);
      }
      return buildSingleCommitDiff(headCommit);
    }
    if (interdiffEnabled) return interdiffLoadedDiffs[selectedFile] ?? null;
    return loadedDiffs[selectedFile] ?? null;
  }, [
    selectedFile,
    loadedDiffs,
    interdiffEnabled,
    interdiffLoadedDiffs,
    versionCompareNoChangeFiles,
    commits,
    selectedCommitSha,
    compareToCommitSha,
    compareToSha,
    commitsByVersion,
  ]);
}

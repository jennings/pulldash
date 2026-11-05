import { useMemo } from "react";
import { parseDiffFromFile } from "@pierre/diffs";
import {
  usePRReviewSelector,
  getLoadedFileDiff,
  parseChangeId,
  type LoadedDiff,
} from ".";
import type { PRCommit } from "@/browser/contexts/github";
import { escapeHtml } from "@/shared/diff-utils";
import { formatDateTime } from "@/browser/lib/dates";
import {
  contextOnlyFileDiff,
  emptyLoadedDiff,
  hashText,
} from "@/browser/lib/file-diff";
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

function getCommitFields(
  commit: PRCommit,
  changeId?: string | null
): CommitField[] {
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
      value: formatDateTime(new Date(author.date)),
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
        value: formatDateTime(new Date(committer.date)),
        kind: "date",
      });
    }
  }

  if (changeId) {
    fields.push({ label: "Change-Id", value: changeId, kind: "sha" });
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

export function getCommitFieldLabel(
  line: number,
  commit: PRCommit,
  changeId?: string | null
): string {
  const fields = getCommitFields(commit, changeId);
  const messageLines = commit.commit.message.split("\n");

  // Field lines (before the separator)
  let current = 1;
  for (const f of fields) {
    if (line === current) return f.label;
    current++;
  }

  // First separator
  current++;

  // Message lines
  for (let i = 0; i < messageLines.length; i++) {
    if (line === current) return i === 0 ? "Subject" : "Description";
    current++;
  }

  // Stats separator and stats
  if (commit.stats) {
    current++; // separator
    if (line === current) return "Stats";
  }

  return `Line ${line}`;
}

export function buildMetadataLines(
  commit: PRCommit,
  changeId?: string | null
): MetadataLine[] {
  const lines: MetadataLine[] = [];
  const fields = getCommitFields(commit, changeId);

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

/** The metadata pseudo-file's text: one line per metadata line. */
function metadataText(commit: PRCommit, changeId?: string | null): string {
  return (
    buildMetadataLines(commit, changeId)
      .map((line) => line.raw)
      .join("\n") + "\n"
  );
}

const metadataDiffs = new Map<string, LoadedDiff>();
const MAX_METADATA_DIFFS = 50;

/**
 * Metadata diffs are rebuilt whenever `commits` or `commitChangeIds` change,
 * usually to the same text. The viewer keys its item on the diff object, so
 * identical text must give back the identical object.
 */
function cachedMetadataDiff(key: string, build: () => LoadedDiff): LoadedDiff {
  const cached = metadataDiffs.get(key);
  if (cached) return cached;
  if (metadataDiffs.size >= MAX_METADATA_DIFFS) {
    metadataDiffs.delete(metadataDiffs.keys().next().value!);
  }
  const diff = build();
  metadataDiffs.set(key, diff);
  return diff;
}

export function buildSingleCommitDiff(
  commit: PRCommit,
  changeId?: string | null
): LoadedDiff {
  const text = metadataText(commit, changeId);
  const cacheKey = `commit-metadata:${commit.sha}:${hashText(text)}`;
  return cachedMetadataDiff(cacheKey, () => ({
    fileDiff: contextOnlyFileDiff(COMMIT_FILE, text, {
      lang: "text",
      cacheKey,
    }),
  }));
}

/** What changed in the commit metadata between two versions of a commit. */
export function buildMetadataComparison(
  prevCommit: PRCommit,
  headCommit: PRCommit,
  prevChangeId?: string | null,
  headChangeId?: string | null
): LoadedDiff {
  const prevText = metadataText(prevCommit, prevChangeId);
  const headText = metadataText(headCommit, headChangeId);
  const file = (contents: string, sha: string) => ({
    name: COMMIT_FILE,
    contents,
    lang: "text" as const,
    cacheKey: `commit-metadata:${sha}:${hashText(contents)}`,
  });
  const prev = file(prevText, prevCommit.sha);
  const head = file(headText, headCommit.sha);
  return cachedMetadataDiff(`${prev.cacheKey}\n${head.cacheKey}`, () => ({
    fileDiff: parseDiffFromFile(prev, head),
  }));
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

export function useCurrentDiff(): LoadedDiff | null {
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const loadedDiffs = usePRReviewSelector((s) => s.loadedDiffs);
  const interdiffEnabled = usePRReviewSelector((s) => s.interdiffEnabled);
  const interdiffError = usePRReviewSelector((s) => s.interdiffError);
  const interdiffLoadedDiffs = usePRReviewSelector(
    (s) => s.interdiffLoadedDiffs
  );
  const versionCompareNoChangeFiles = usePRReviewSelector(
    (s) => s.versionCompareNoChangeFiles
  );
  const commits = usePRReviewSelector((s) => s.commits);
  const selectedCommitSha = usePRReviewSelector((s) => s.selectedCommitSha);
  const selectedCommitDetails = usePRReviewSelector(
    (s) => s.selectedCommitDetails
  );
  const compareToCommitSha = usePRReviewSelector((s) => s.compareToCommitSha);
  const compareToSha = usePRReviewSelector((s) => s.compareToSha);
  const commitsByVersion = usePRReviewSelector((s) => s.commitsByVersion);
  const commitChangeIds = usePRReviewSelector((s) => s.commitChangeIds);
  return useMemo(() => {
    if (!selectedFile) return null;
    if (interdiffEnabled && interdiffError)
      return emptyLoadedDiff(selectedFile, { error: interdiffError });
    if (versionCompareNoChangeFiles.includes(selectedFile))
      return emptyLoadedDiff(selectedFile);
    if (selectedFile === COMMIT_FILE && selectedCommitSha) {
      const headCommit =
        commits.find((c) => c.sha === selectedCommitSha) ??
        selectedCommitDetails;
      if (!headCommit) return null;
      const headChangeId =
        commitChangeIds[selectedCommitSha] ??
        parseChangeId(headCommit.commit.message);
      if (interdiffEnabled && compareToCommitSha) {
        const prevCommit = findCommitBySha(
          compareToCommitSha,
          commits,
          commitsByVersion
        );
        if (prevCommit) {
          const prevChangeId =
            commitChangeIds[compareToCommitSha] ??
            parseChangeId(prevCommit.commit.message);
          return buildMetadataComparison(
            prevCommit,
            headCommit,
            prevChangeId,
            headChangeId
          );
        }
      }
      return buildSingleCommitDiff(headCommit, headChangeId);
    }
    return getLoadedFileDiff(
      { interdiffEnabled, interdiffLoadedDiffs, loadedDiffs },
      selectedFile
    );
  }, [
    selectedFile,
    loadedDiffs,
    interdiffEnabled,
    interdiffError,
    interdiffLoadedDiffs,
    versionCompareNoChangeFiles,
    commits,
    selectedCommitSha,
    selectedCommitDetails,
    compareToCommitSha,
    compareToSha,
    commitsByVersion,
  ]);
}

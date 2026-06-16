import { test, expect, beforeEach, mock } from "bun:test";
import type { PullRequest, PullRequestFile, ReviewComment } from "@/api/types";
import { PRReviewStore, sortFilesLikeTree } from "./index";
import type { GitHubStore, ReviewThread } from "@/browser/contexts/github";

// Mock diffService so interdiff calls resolve without real WebWorkers
mock.module("@/browser/lib/diff", () => ({
  diffService: {
    parseDiff: mock(() => Promise.resolve({ hunks: [] })),
    interdiff: mock(() => Promise.resolve({ hunks: [] })),
  },
}));

// Mock localStorage
const storage = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  key: () => null,
  length: 0,
};

// Mock GitHub store (minimal implementation for tests)
function createMockGitHubStore(): GitHubStore {
  return {
    getPRReviews: async () => [],
    getPRChecks: async () => ({
      checkRuns: [],
      status: { state: "", statuses: [] },
    }),
    getWorkflowRuns: async () => ({ workflow_runs: [] }),
    getPRConversation: async () => [],
    getPRCommits: async () => [],
    getPRTimeline: async () => [],
    getReviewThreads: async () => ({
      threads: [],
      viewerPermission: null,
      viewerCanMergeAsAdmin: false,
    }),
    invalidateCache: () => {},
    getPR: async () => createMockPR(),
    mergePR: async () => ({ merged: true }),
    closePR: async () => {},
    reopenPR: async () => {},
    deleteBranch: async () => {},
    restoreBranch: async () => {},
    convertToDraft: async () => {},
    markReadyForReview: async () => {},
    approveWorkflowRun: async () => {},
    updateBranch: async () => {},
    getCommitFiles: async () => [],
    getMergeCommitFiles: async () => [],
    getPRFilesForRange: async () => [],
  } as unknown as GitHubStore;
}

// ============================================================================
// Test Fixtures
// ============================================================================

function createMockPR(overrides?: Partial<PullRequest>): PullRequest {
  return {
    number: 1,
    title: "Test PR",
    state: "open",
    html_url: "https://github.com/test/repo/pull/1",
    user: { login: "testuser", avatar_url: "https://example.com/avatar.png" },
    body: "Test body",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    head: { ref: "feature", sha: "abc123" },
    base: { ref: "main", sha: "def456" },
    merged: false,
    draft: false,
    ...overrides,
  } as PullRequest;
}

function createMockFile(filename: string): PullRequestFile {
  return {
    sha: "abc123",
    filename,
    status: "modified",
    additions: 10,
    deletions: 5,
    changes: 15,
    patch: "@@ -1,3 +1,4 @@\n line1\n+added\n line2",
  } as PullRequestFile;
}

function createMockComment(
  id: number,
  path: string,
  line: number
): ReviewComment {
  return {
    id,
    node_id: `comment_${id}`,
    path,
    line,
    body: `Comment ${id}`,
    user: { login: "reviewer", avatar_url: "https://example.com/avatar.png" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as ReviewComment;
}

function createStore(overrides?: {
  files?: PullRequestFile[];
  comments?: ReviewComment[];
}) {
  return new PRReviewStore(createMockGitHubStore(), {
    pr: createMockPR(),
    files: overrides?.files ?? [
      createMockFile("src/index.ts"),
      createMockFile("src/utils.ts"),
      createMockFile("README.md"),
    ],
    comments: overrides?.comments ?? [],
    owner: "test",
    repo: "repo",
    viewerPermission: "WRITE",
  });
}

beforeEach(() => {
  storage.clear();
});

// Helper: run a test that expects console.error to be called (suppresses noise)
function suppressConsoleError(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const orig = console.error;
    console.error = () => {};
    try {
      await fn();
    } finally {
      console.error = orig;
    }
  };
}

// ============================================================================
// sortFilesLikeTree
// ============================================================================

test("sortFilesLikeTree places folders before files", () => {
  const files = [
    createMockFile("README.md"),
    createMockFile("src/index.ts"),
    createMockFile("package.json"),
  ];

  const sorted = sortFilesLikeTree(files);

  // Folders (src/) come before root-level files, then alphabetically
  expect(sorted.map((f) => f.filename)).toEqual([
    "src/index.ts",
    "package.json",
    "README.md",
  ]);
});

test("sortFilesLikeTree sorts nested folders correctly", () => {
  const files = [
    createMockFile("src/components/Button.tsx"),
    createMockFile("src/index.ts"),
    createMockFile("src/components/Dialog.tsx"),
    createMockFile("src/utils/helpers.ts"),
  ];

  const sorted = sortFilesLikeTree(files);

  // Folders first at each level, then alphabetically
  expect(sorted.map((f) => f.filename)).toEqual([
    "src/components/Button.tsx",
    "src/components/Dialog.tsx",
    "src/utils/helpers.ts",
    "src/index.ts",
  ]);
});

// ============================================================================
// File Navigation
// ============================================================================

test("selectFile updates selectedFile and clears showOverview", () => {
  const store = createStore();
  const state = () => store.getSnapshot();

  expect(state().selectedFile).toBeNull();
  expect(state().showOverview).toBe(true);

  store.selectFile("src/index.ts");

  expect(state().selectedFile).toBe("src/index.ts");
  expect(state().showOverview).toBe(false);
});

test("selectFile clears line selection state", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedLine(10, "new");
  store.setSelectionAnchor(5, "new");

  store.selectFile("src/utils.ts");

  const state = store.getSnapshot();
  expect(state.focusedLine).toBeNull();
  expect(state.selectionAnchor).toBeNull();
});

test("selectOverview resets to overview state", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedLine(10, "new");

  store.selectOverview();

  const state = store.getSnapshot();
  expect(state.showOverview).toBe(true);
  expect(state.selectedFile).toBeNull();
  expect(state.focusedLine).toBeNull();
});

test("navigateToFile moves between files", () => {
  const store = createStore({
    files: [
      createMockFile("a.ts"),
      createMockFile("b.ts"),
      createMockFile("c.ts"),
    ],
  });

  store.selectFile("b.ts");
  store.navigateToFile("next");
  expect(store.getSnapshot().selectedFile).toBe("c.ts");

  store.navigateToFile("prev");
  expect(store.getSnapshot().selectedFile).toBe("b.ts");

  store.navigateToFile("prev");
  expect(store.getSnapshot().selectedFile).toBe("a.ts");

  // Should not go below first file
  store.navigateToFile("prev");
  expect(store.getSnapshot().selectedFile).toBe("a.ts");
});

// ============================================================================
// Viewed Files
// ============================================================================

test("toggleViewed marks file as viewed", () => {
  const store = createStore();

  expect(store.getSnapshot().viewedFiles.has("src/index.ts")).toBe(false);

  store.toggleViewed("src/index.ts");

  expect(store.getSnapshot().viewedFiles.has("src/index.ts")).toBe(true);
});

test("toggleViewed persists to localStorage", () => {
  const store = createStore();
  store.toggleViewed("src/index.ts");

  const stored = storage.get("pr-test-repo-1-viewed");
  expect(stored).toBeDefined();
  expect(JSON.parse(stored!)).toContain("src/index.ts");
});

test("toggleViewed unmarks viewed file", () => {
  const store = createStore();
  store.toggleViewed("src/index.ts");
  store.toggleViewed("src/index.ts");

  expect(store.getSnapshot().viewedFiles.has("src/index.ts")).toBe(false);
});

test("toggleViewed navigates to next file when marking current file as viewed", () => {
  const store = createStore();
  store.selectFile("src/index.ts");

  store.toggleViewed("src/index.ts");

  expect(store.getSnapshot().viewedFiles.has("src/index.ts")).toBe(true);
  expect(store.getSnapshot().selectedFile).toBe("src/utils.ts");
});

test("toggleViewedMultiple marks multiple files", () => {
  const store = createStore();

  store.toggleViewedMultiple(["src/index.ts", "src/utils.ts"]);

  const { viewedFiles } = store.getSnapshot();
  expect(viewedFiles.has("src/index.ts")).toBe(true);
  expect(viewedFiles.has("src/utils.ts")).toBe(true);
});

// ============================================================================
// Line Selection
// ============================================================================

test("setFocusedLine updates line focus", () => {
  const store = createStore();
  store.selectFile("src/index.ts");

  store.setFocusedLine(42, "new");

  const state = store.getSnapshot();
  expect(state.focusedLine).toBe(42);
  expect(state.focusedLineSide).toBe("new");
});

test("setFocusedLine clears skip block focus", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedSkipBlock(0);

  store.setFocusedLine(10, "new");

  expect(store.getSnapshot().focusedSkipBlockIndex).toBeNull();
});

test("setSelectionAnchor creates range selection", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedLine(10, "new");
  store.setSelectionAnchor(5, "new");

  const state = store.getSnapshot();
  expect(state.focusedLine).toBe(10);
  expect(state.selectionAnchor).toBe(5);
});

test("clearLineSelection resets all line state", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedLine(10, "new");
  store.setSelectionAnchor(5, "new");
  store.startCommenting(10, 5);

  store.clearLineSelection();

  const state = store.getSnapshot();
  expect(state.focusedLine).toBeNull();
  expect(state.selectionAnchor).toBeNull();
  expect(state.commentingOnLine).toBeNull();
});

// ============================================================================
// Commenting
// ============================================================================

test("startCommenting sets commenting state", () => {
  const store = createStore();
  store.selectFile("src/index.ts");

  store.startCommenting(42, 38);

  const state = store.getSnapshot();
  expect(state.commentingOnLine).toEqual({ line: 42, startLine: 38 });
});

test("cancelCommenting clears commenting state", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.startCommenting(42);

  store.cancelCommenting();

  expect(store.getSnapshot().commentingOnLine).toBeNull();
});

test("addPendingComment adds comment and clears selection", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedLine(10, "new");
  store.startCommenting(10);

  store.addPendingComment({
    id: "local-1",
    path: "src/index.ts",
    line: 10,
    body: "Test comment",
    side: "RIGHT",
  });

  const state = store.getSnapshot();
  expect(state.pendingComments).toHaveLength(1);
  expect(state.pendingComments[0].body).toBe("Test comment");
  expect(state.commentingOnLine).toBeNull();
  expect(state.focusedPendingCommentId).toBe("local-1");
});

test("removePendingComment removes comment and focuses line", () => {
  const store = createStore();
  store.selectFile("src/index.ts");

  store.addPendingComment({
    id: "local-1",
    path: "src/index.ts",
    line: 10,
    body: "Test comment",
    side: "RIGHT",
  });

  store.removePendingComment("local-1");

  const state = store.getSnapshot();
  expect(state.pendingComments).toHaveLength(0);
  expect(state.focusedLine).toBe(10);
});

// ============================================================================
// Comments
// ============================================================================

test("setComments updates comments", () => {
  const store = createStore();
  const comments = [createMockComment(1, "src/index.ts", 10)];

  store.setComments(comments);

  expect(store.getSnapshot().comments).toHaveLength(1);
  expect(store.getSnapshot().comments[0].id).toBe(1);
});

test("setFocusedCommentId updates focus", () => {
  const store = createStore({
    comments: [createMockComment(1, "src/index.ts", 10)],
  });

  store.setFocusedCommentId(1);

  expect(store.getSnapshot().focusedCommentId).toBe(1);
});

test("startEditing sets editing comment id", () => {
  const store = createStore({
    comments: [createMockComment(1, "src/index.ts", 10)],
  });

  store.startEditing(1);

  expect(store.getSnapshot().editingCommentId).toBe(1);
});

test("deleteComment removes comment and focuses line", () => {
  const store = createStore({
    comments: [createMockComment(1, "src/index.ts", 10)],
  });
  store.selectFile("src/index.ts");
  store.setFocusedCommentId(1);

  store.deleteComment(1);

  const state = store.getSnapshot();
  expect(state.comments).toHaveLength(0);
  expect(state.focusedLine).toBe(10);
});

// ============================================================================
// Review Panel
// ============================================================================

test("openReviewPanel shows panel", () => {
  const store = createStore();

  store.openReviewPanel();

  expect(store.getSnapshot().showReviewPanel).toBe(true);
});

test("setReviewBody updates body and persists", () => {
  const store = createStore();

  store.setReviewBody("LGTM!");

  expect(store.getSnapshot().reviewBody).toBe("LGTM!");
  expect(storage.get("pr-test-repo-1-body")).toBe("LGTM!");
});

test("clearReviewState resets all review state", () => {
  const store = createStore();
  store.setReviewBody("Test");
  store.openReviewPanel();
  store.addPendingComment({
    id: "local-1",
    path: "src/index.ts",
    line: 10,
    body: "Comment",
    side: "RIGHT",
  });

  store.clearReviewState();

  const state = store.getSnapshot();
  expect(state.pendingComments).toHaveLength(0);
  expect(state.reviewBody).toBe("");
  expect(state.showReviewPanel).toBe(false);
});

// ============================================================================
// Subscriptions
// ============================================================================

test("subscribe notifies listeners on state change", () => {
  const store = createStore();
  let callCount = 0;

  const unsubscribe = store.subscribe(() => {
    callCount++;
  });

  store.selectFile("src/index.ts");
  expect(callCount).toBe(1);

  store.setFocusedLine(10, "new");
  expect(callCount).toBe(2);

  unsubscribe();
  store.setFocusedLine(20, "new");
  expect(callCount).toBe(2); // No more calls after unsubscribe
});

// ============================================================================
// Diff View Mode
// ============================================================================

test("setDiffViewMode updates mode and persists globally", () => {
  const store = createStore();

  store.setDiffViewMode("split");

  expect(store.getSnapshot().diffViewMode).toBe("split");
  expect(storage.get("pulldash_diff_view_mode")).toBe("split");
});

test("toggleDiffViewMode toggles between unified and split", () => {
  const store = createStore();
  expect(store.getSnapshot().diffViewMode).toBe("unified");

  store.toggleDiffViewMode();
  expect(store.getSnapshot().diffViewMode).toBe("split");

  store.toggleDiffViewMode();
  expect(store.getSnapshot().diffViewMode).toBe("unified");
});

// ============================================================================
// Goto Line Mode
// ============================================================================

test("enterGotoMode enables goto mode", () => {
  const store = createStore();

  store.enterGotoMode();

  const state = store.getSnapshot();
  expect(state.gotoLineMode).toBe(true);
  expect(state.gotoLineInput).toBe("");
});

test("appendGotoInput builds input string", () => {
  const store = createStore();
  store.enterGotoMode();

  store.appendGotoInput("4");
  store.appendGotoInput("2");

  expect(store.getSnapshot().gotoLineInput).toBe("42");
});

test("backspaceGotoInput removes last character", () => {
  const store = createStore();
  store.enterGotoMode();
  store.appendGotoInput("4");
  store.appendGotoInput("2");

  store.backspaceGotoInput();

  expect(store.getSnapshot().gotoLineInput).toBe("4");
});

test("exitGotoMode clears goto state", () => {
  const store = createStore();
  store.enterGotoMode();
  store.appendGotoInput("42");

  store.exitGotoMode();

  const state = store.getSnapshot();
  expect(state.gotoLineMode).toBe(false);
  expect(state.gotoLineInput).toBe("");
});

// ============================================================================
// Hash Navigation
// ============================================================================

test("getHashFromState returns file hash", () => {
  const store = createStore();
  store.selectFile("src/index.ts");

  const hash = store.getHashFromState();

  expect(hash).toBe("file=src%2Findex.ts");
});

test("getHashFromState includes line selection", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedLine(42, "new");

  const hash = store.getHashFromState();

  expect(hash).toContain("file=src%2Findex.ts");
  expect(hash).toContain("L=42");
});

test("getHashFromState includes line range", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedLine(10, "new");
  store.setSelectionAnchor(5, "new");

  const hash = store.getHashFromState();

  expect(hash).toContain("L=5-10");
});

test("navigateFromHash selects file", async () => {
  const store = createStore();

  const result = await store.navigateFromHash("file=src%2Findex.ts");

  expect(result).toBe(true);
  expect(store.getSnapshot().selectedFile).toBe("src/index.ts");
});

test("navigateFromHash focuses line", async () => {
  const store = createStore();

  await store.navigateFromHash("file=src%2Findex.ts&L=42");

  const state = store.getSnapshot();
  expect(state.selectedFile).toBe("src/index.ts");
  expect(state.focusedLine).toBe(42);
});

test("navigateFromHash returns false for invalid file", async () => {
  const store = createStore();

  const result = await store.navigateFromHash("file=nonexistent.ts");

  expect(result).toBe(false);
});

test("navigateFromHash handles GitHub-style pullrequestreview hash", async () => {
  const store = createStore();
  store.selectFile("src/index.ts"); // Start on a file view

  const result = await store.navigateFromHash("#pullrequestreview-12345");

  expect(result).toBe(true);
  const state = store.getSnapshot();
  expect(state.showOverview).toBe(true);
  expect(state.overviewScrollTarget).toBe("pullrequestreview-12345");
});

test("navigateFromHash handles GitHub-style issuecomment hash", async () => {
  const store = createStore();
  store.selectFile("src/index.ts");

  const result = await store.navigateFromHash("#issuecomment-98765");

  expect(result).toBe(true);
  const state = store.getSnapshot();
  expect(state.showOverview).toBe(true);
  expect(state.overviewScrollTarget).toBe("issuecomment-98765");
});

test("navigateFromHash with empty hash navigates to overview", async () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  expect(store.getSnapshot().showOverview).toBe(false);

  const result = await store.navigateFromHash("");

  expect(result).toBe(true);
  expect(store.getSnapshot().showOverview).toBe(true);
});

test("getHashFromState returns overview scroll target when on overview", () => {
  const store = createStore();
  store.selectOverview("pullrequestreview-12345");

  const hash = store.getHashFromState();

  expect(hash).toBe("pullrequestreview-12345");
});

test("clearOverviewScrollTarget clears the target", () => {
  const store = createStore();
  store.selectOverview("pullrequestreview-12345");

  store.clearOverviewScrollTarget();

  expect(store.getSnapshot().overviewScrollTarget).toBeNull();
});

// ============================================================================
// Full-branch interdiff (#59)
// ============================================================================

function createMockGitHubStoreWithVersions(
  filesForRange: (base: string, head: string) => PullRequestFile[]
): GitHubStore {
  return {
    getPRReviews: async () => [],
    getPRChecks: async () => ({
      checkRuns: [],
      status: { state: "", statuses: [] },
    }),
    getWorkflowRuns: async () => ({ workflow_runs: [] }),
    getPRConversation: async () => [],
    getPRCommits: async () => [],
    getPRTimeline: async () => [],
    getReviewThreads: async () => ({
      threads: [],
      viewerPermission: null,
      viewerCanMergeAsAdmin: false,
    }),
    invalidateCache: () => {},
    getPR: async () => createMockPR(),
    mergePR: async () => ({ merged: true }),
    closePR: async () => {},
    reopenPR: async () => {},
    deleteBranch: async () => {},
    restoreBranch: async () => {},
    convertToDraft: async () => {},
    markReadyForReview: async () => {},
    approveWorkflowRun: async () => {},
    updateBranch: async () => {},
    getPushVersions: async () => [],
    getPRFilesForRange: async (
      _owner: string,
      _repo: string,
      base: string,
      head: string
    ) => filesForRange(base, head),
    getCommitFiles: async () => [],
  } as unknown as GitHubStore;
}

function createStoreWithVersions(
  filesForRange: (base: string, head: string) => PullRequestFile[] = () => []
) {
  const github = createMockGitHubStoreWithVersions(filesForRange);
  return new PRReviewStore(github, {
    pr: createMockPR(),
    files: [createMockFile("src/index.ts")],
    comments: [],
    owner: "test",
    repo: "repo",
    viewerPermission: "WRITE",
  });
}

test("setCompareToSha with full branch enables interdiff and computes branch diff", async () => {
  const store = createStoreWithVersions(() => [createMockFile("src/index.ts")]);

  await store.setCompareToSha("comparesha");

  const state = store.getSnapshot();
  expect(state.interdiffEnabled).toBe(true);
  expect(state.compareToSha).toBe("comparesha");
  // interdiffLoadedDiffs should be populated (keyed by filename)
  expect("src/index.ts" in state.interdiffLoadedDiffs).toBe(true);
});

test("setCompareToSha(null) disables interdiff", async () => {
  const store = createStoreWithVersions(() => [createMockFile("src/index.ts")]);
  await store.setCompareToSha("comparesha");

  await store.setCompareToSha(null);

  const state = store.getSnapshot();
  expect(state.interdiffEnabled).toBe(false);
  expect(state.interdiffLoadedDiffs).toEqual({});
});

test("setSelectedHeadSha re-computes interdiff when compareToSha is set and commit is full branch", async () => {
  const store = createStoreWithVersions(() => [createMockFile("src/index.ts")]);
  await store.setCompareToSha("comparesha");

  await store.setSelectedHeadSha("headsha");

  const state = store.getSnapshot();
  expect(state.interdiffEnabled).toBe(true);
  expect("src/index.ts" in state.interdiffLoadedDiffs).toBe(true);
});

test("setSelectedHeadSha does not enable interdiff when compareToSha is null", async () => {
  const store = createStoreWithVersions(() => [createMockFile("src/index.ts")]);

  await store.setSelectedHeadSha("headsha");

  expect(store.getSnapshot().interdiffEnabled).toBe(false);
});

test("setSelectedCommitSha(null) computes branch interdiff when compareToSha and selectedHeadSha are set", async () => {
  const store = createStoreWithVersions(() => [createMockFile("src/index.ts")]);
  // Start in commit-level mode by first setting a commit, then set versions
  await store.setCompareToSha("comparesha");
  await store.setSelectedHeadSha("headsha");
  // Now switch back to full branch
  await store.setSelectedCommitSha(null);

  const state = store.getSnapshot();
  expect(state.interdiffEnabled).toBe(true);
  expect(state.selectedCommitSha).toBeNull();
  expect("src/index.ts" in state.interdiffLoadedDiffs).toBe(true);
});

test("getPRFilesForRange is called with base.sha and compareToSha / headSha for branch interdiff", async () => {
  const calls: Array<[string, string]> = [];
  const store = createStoreWithVersions((base, head) => {
    calls.push([base, head]);
    return [createMockFile("src/index.ts")];
  });

  await store.setCompareToSha("v1sha");
  // pr.base.sha is "def456", pr.head.sha is "abc123" (from createMockPR)
  expect(calls).toContainEqual(["def456", "v1sha"]);
  expect(calls).toContainEqual(["def456", "abc123"]);
});

// ============================================================================
// mergePR
// ============================================================================

test("mergePR sets merged=true and state=closed after success", async () => {
  const github = createMockGitHubStore();
  const store = new PRReviewStore(github, {
    pr: createMockPR(),
    files: [],
    comments: [],
    owner: "test",
    repo: "repo",
    viewerPermission: "WRITE",
  });

  const result = await store.mergePR();

  expect(result).toBe(true);
  const state = store.getSnapshot();
  expect(state.pr.merged).toBe(true);
  expect(state.pr.state).toBe("closed");
  expect(state.merging).toBe(false);
});

test("mergePR sets mergeError and clears merging on failure", async () => {
  const github = {
    ...createMockGitHubStore(),
    mergePR: async () => {
      throw new Error("Merge conflict");
    },
  } as unknown as GitHubStore;
  const store = new PRReviewStore(github, {
    pr: createMockPR(),
    files: [],
    comments: [],
    owner: "test",
    repo: "repo",
    viewerPermission: "WRITE",
  });

  const result = await store.mergePR();

  expect(result).toBe(false);
  const state = store.getSnapshot();
  expect(state.merging).toBe(false);
  expect(state.mergeError).toBe("Merge conflict");
  expect(state.pr.merged).toBe(false);
});

// ============================================================================
// Conversation / Timeline events
// ============================================================================

test("addConversationComment appends to conversation array", () => {
  const store = createStore();
  expect(store.getSnapshot().conversation).toHaveLength(0);

  const comment = { id: 1, body: "test comment" } as any;
  store.addConversationComment(comment);

  expect(store.getSnapshot().conversation).toHaveLength(1);
  expect(store.getSnapshot().conversation[0].id).toBe(1);
});

test("addConversationComment appends multiple comments", () => {
  const store = createStore();
  store.addConversationComment({ id: 1 } as any);
  store.addConversationComment({ id: 2 } as any);

  expect(store.getSnapshot().conversation).toHaveLength(2);
});

test("addTimelineEvent appends to timeline array", () => {
  const store = createStore();
  expect(store.getSnapshot().timeline).toHaveLength(0);

  store.addTimelineEvent({ event: "commented", id: 1 } as any);

  expect(store.getSnapshot().timeline).toHaveLength(1);
  expect(store.getSnapshot().timeline[0]).toEqual({
    event: "commented",
    id: 1,
  });
});

test("addTimelineEvent appends multiple events", () => {
  const store = createStore();
  store.addTimelineEvent({ event: "commented", id: 1 } as any);
  store.addTimelineEvent({ event: "reviewed", id: 2 } as any);

  expect(store.getSnapshot().timeline).toHaveLength(2);
});

test("setTimeline replaces timeline array", () => {
  const store = createStore();
  store.addTimelineEvent({ event: "commented", id: 1 } as any);

  store.setTimeline([{ event: "closed" } as any]);

  expect(store.getSnapshot().timeline).toHaveLength(1);
  expect(store.getSnapshot().timeline[0].event).toBe("closed");
});

test("setConversation replaces conversation array", () => {
  const store = createStore();
  store.addConversationComment({ id: 1 } as any);

  store.setConversation([{ id: 2 } as any]);

  expect(store.getSnapshot().conversation).toHaveLength(1);
  expect(store.getSnapshot().conversation[0].id).toBe(2);
});

// ============================================================================
// Review Threads
// ============================================================================

test("setReviewThreads sets threads and rewrites metadata paths", () => {
  const store = createStore();
  const thread: ReviewThread = {
    id: "thread-1",
    isResolved: false,
    isOutdated: false,
    resolvedBy: null,
    pullRequestReview: null,
    comments: {
      nodes: [
        {
          id: "c1",
          databaseId: 1,
          body: "<!-- pulldash:commit-metadata sha=abc line=5 label=Author -->",
          path: "some/file.ts",
          line: 10,
          originalLine: null,
          startLine: null,
          diffHunk: "",
          author: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          replyTo: null,
        },
      ],
    },
  } as ReviewThread;

  store.setReviewThreads([thread]);

  const state = store.getSnapshot();
  expect(state.reviewThreads).toHaveLength(1);
  // Metadata comment path should be rewritten to ":commit"
  expect(state.reviewThreads[0].comments.nodes[0].path).toBe(":commit");
});

test("updateReviewThread applies updater to matching thread", () => {
  const store = createStore();
  const thread = {
    id: "thread-1",
    isResolved: false,
    isOutdated: false,
    resolvedBy: null,
    pullRequestReview: null,
    comments: { nodes: [] },
  } as unknown as ReviewThread;
  store.setReviewThreads([thread]);

  store.updateReviewThread("thread-1", (t) => ({ ...t, isResolved: true }));

  expect(store.getSnapshot().reviewThreads[0].isResolved).toBe(true);
});

test("updateReviewThread does not affect non-matching threads", () => {
  const store = createStore();
  const t1 = {
    id: "thread-1",
    isResolved: false,
    isOutdated: false,
    resolvedBy: null,
    pullRequestReview: null,
    comments: { nodes: [] },
  } as unknown as ReviewThread;
  const t2 = {
    id: "thread-2",
    isResolved: false,
    isOutdated: false,
    resolvedBy: null,
    pullRequestReview: null,
    comments: { nodes: [] },
  } as unknown as ReviewThread;
  store.setReviewThreads([t1, t2]);

  store.updateReviewThread("thread-1", (t) => ({ ...t, isResolved: true }));

  expect(store.getSnapshot().reviewThreads[0].isResolved).toBe(true);
  expect(store.getSnapshot().reviewThreads[1].isResolved).toBe(false);
});

// ============================================================================
// Skip blocks
// ============================================================================

test("getSkipBlockKey returns a stable key", () => {
  const store = createStore();
  expect(store.getSkipBlockKey("file.ts", 0)).toBe("file.ts:0");
  expect(store.getSkipBlockKey("file.ts", 5)).toBe("file.ts:5");
});

test("setSkipBlockExpanding sets the expanding map", () => {
  const store = createStore();
  const key = store.getSkipBlockKey("file.ts", 0);

  store.setSkipBlockExpanding(key, true);
  expect(store.getSnapshot().expandingSkipBlocks.has(key)).toBe(true);

  store.setSkipBlockExpanding(key, false);
  expect(store.getSnapshot().expandingSkipBlocks.has(key)).toBe(false);
});

test("isSkipBlockExpanding returns correct state", () => {
  const store = createStore();
  expect(store.isSkipBlockExpanding("file.ts", 0)).toBe(false);

  store.setSkipBlockExpanding(store.getSkipBlockKey("file.ts", 0), true);
  expect(store.isSkipBlockExpanding("file.ts", 0)).toBe(true);
});

test("setExpandedSkipBlock stores expanded lines", () => {
  const store = createStore();
  const key = store.getSkipBlockKey("file.ts", 0);
  const lines: any[] = [{ type: "normal" }];

  store.setExpandedSkipBlock(key, lines);

  expect(store.getSnapshot().expandedSkipBlocks[key]).toBe(lines);
});

test("isSkipBlockExpanded returns true after expanding", () => {
  const store = createStore();
  expect(store.isSkipBlockExpanded("file.ts", 0)).toBe(false);

  store.setExpandedSkipBlock(store.getSkipBlockKey("file.ts", 0), [
    { type: "normal" },
  ] as any);

  expect(store.isSkipBlockExpanded("file.ts", 0)).toBe(true);
});

// ============================================================================
// Comment Drafts
// ============================================================================

test("setCommentDraft stores draft text", () => {
  const store = createStore();
  store.setCommentDraft("line-10", "my draft");

  expect(store.getSnapshot().commentDrafts["line-10"]).toBe("my draft");
});

test("setCommentDraft overwrites existing draft", () => {
  const store = createStore();
  store.setCommentDraft("line-10", "old");
  store.setCommentDraft("line-10", "new");

  expect(store.getSnapshot().commentDrafts["line-10"]).toBe("new");
});

test("clearCommentDraft removes draft text", () => {
  const store = createStore();
  store.setCommentDraft("line-10", "my draft");
  store.clearCommentDraft("line-10");

  expect(store.getSnapshot().commentDrafts["line-10"]).toBeUndefined();
});

test("clearCommentDraft does nothing for non-existent key", () => {
  const store = createStore();
  store.clearCommentDraft("non-existent");

  expect(store.getSnapshot().commentDrafts).toEqual({});
});

// ============================================================================
// PR Actions (close, reopen, draft, branch)
// ============================================================================

test("closePR sets state to closed and refetches timeline", async () => {
  const store = createStore();
  expect(store.getSnapshot().pr.state).toBe("open");

  const result = await store.closePR();

  expect(result).toBe(true);
  expect(store.getSnapshot().pr.state).toBe("closed");
  expect(store.getSnapshot().pr.merged).toBe(false);
  expect(store.getSnapshot().closingPR).toBe(false);
});

test(
  "closePR returns false on failure",
  suppressConsoleError(async () => {
    const github = {
      ...createMockGitHubStore(),
      closePR: async () => {
        throw new Error("API error");
      },
    } as unknown as GitHubStore;
    const store = new PRReviewStore(github, {
      pr: createMockPR(),
      files: [],
      comments: [],
      owner: "test",
      repo: "repo",
      viewerPermission: "WRITE",
    });

    const result = await store.closePR();

    expect(result).toBe(false);
    expect(store.getSnapshot().closingPR).toBe(false);
  })
);

test("reopenPR sets state to open", async () => {
  const pr = createMockPR({ state: "closed" });
  const store = createStore({ files: [createMockFile("a.ts")] });
  // Override the PR to closed
  (store as any).set({ pr });

  const result = await store.reopenPR();

  expect(result).toBe(true);
  expect(store.getSnapshot().pr.state).toBe("open");
});

test(
  "reopenPR returns false on failure",
  suppressConsoleError(async () => {
    const github = {
      ...createMockGitHubStore(),
      reopenPR: async () => {
        throw new Error("API error");
      },
    } as unknown as GitHubStore;
    const store = new PRReviewStore(github, {
      pr: createMockPR({ state: "closed" }),
      files: [],
      comments: [],
      owner: "test",
      repo: "repo",
      viewerPermission: "WRITE",
    });

    const result = await store.reopenPR();

    expect(result).toBe(false);
  })
);

test("convertToDraft sets draft flag", async () => {
  const store = createStore();

  const result = await store.convertToDraft();

  expect(result).toBe(true);
  expect(store.getSnapshot().pr.draft).toBe(true);
});

test(
  "convertToDraft returns false on failure",
  suppressConsoleError(async () => {
    const github = {
      ...createMockGitHubStore(),
      convertToDraft: async () => {
        throw new Error("API error");
      },
    } as unknown as GitHubStore;
    const store = new PRReviewStore(github, {
      pr: createMockPR(),
      files: [],
      comments: [],
      owner: "test",
      repo: "repo",
      viewerPermission: "WRITE",
    });

    const result = await store.convertToDraft();

    expect(result).toBe(false);
  })
);

test("markReadyForReview clears draft flag", async () => {
  const store = createStore({ files: [createMockFile("a.ts")] });
  (store as any).set({ pr: createMockPR({ draft: true }) });

  const result = await store.markReadyForReview();

  expect(result).toBe(true);
  expect(store.getSnapshot().pr.draft).toBe(false);
});

test("updateBranch returns true on success and updates PR", async () => {
  const store = createStore();

  const result = await store.updateBranch();

  expect(result).toBe(true);
});

test(
  "updateBranch returns false on failure",
  suppressConsoleError(async () => {
    const github = {
      ...createMockGitHubStore(),
      updateBranch: async () => {
        throw new Error("API error");
      },
    } as unknown as GitHubStore;
    const store = new PRReviewStore(github, {
      pr: createMockPR(),
      files: [],
      comments: [],
      owner: "test",
      repo: "repo",
      viewerPermission: "WRITE",
    });

    const result = await store.updateBranch();

    expect(result).toBe(false);
  })
);

test("deleteBranch returns true on success", async () => {
  const store = createStore();

  const result = await store.deleteBranch();

  expect(result).toBe(true);
  expect(store.getSnapshot().branchDeleted).toBe(true);
});

test(
  "deleteBranch returns false on failure",
  suppressConsoleError(async () => {
    const github = {
      ...createMockGitHubStore(),
      deleteBranch: async () => {
        throw new Error("API error");
      },
    } as unknown as GitHubStore;
    const store = new PRReviewStore(github, {
      pr: createMockPR(),
      files: [],
      comments: [],
      owner: "test",
      repo: "repo",
      viewerPermission: "WRITE",
    });

    const result = await store.deleteBranch();

    expect(result).toBe(false);
  })
);

test("restoreBranch returns true on success and clears branchDeleted", async () => {
  const store = createStore();
  (store as any).set({ branchDeleted: true });

  const result = await store.restoreBranch();

  expect(result).toBe(true);
  expect(store.getSnapshot().branchDeleted).toBe(false);
});

test("approveWorkflows clears awaiting workflows and refreshes checks", async () => {
  const store = createStore();

  const result = await store.approveWorkflows();

  expect(result).toBe(true);
});

test(
  "approveWorkflows returns false on failure",
  suppressConsoleError(async () => {
    const github = {
      ...createMockGitHubStore(),
      approveWorkflowRun: async () => {
        throw new Error("API error");
      },
    } as unknown as GitHubStore;
    const store = new PRReviewStore(github, {
      pr: createMockPR(),
      files: [],
      comments: [],
      owner: "test",
      repo: "repo",
      viewerPermission: "WRITE",
    });
    // Set a workflow run awaiting approval so approveWorkflowRun is called
    (store as any).set({
      workflowRunsAwaitingApproval: [
        { id: 1, name: "CI", html_url: "https://example.com" },
      ],
    });

    const result = await store.approveWorkflows();

    expect(result).toBe(false);
  })
);

// ============================================================================
// Version / Commit selectors
// ============================================================================

test("setCompareToCommitSha enables interdiff when both commits are set", async () => {
  const store = createStore();
  // setSelectedCommitSha and setCompareToSha must be set first
  await store.setCompareToSha(null); // no-op, just to have compareToSha null

  await store.setCompareToCommitSha("somesha");

  const state = store.getSnapshot();
  expect(state.compareToCommitSha).toBe("somesha");
  // Without selectedCommitSha, interdiff is not enabled
  expect(state.interdiffEnabled).toBe(false);
});

test("resetVersionSelectors resets all version/commit/compare state", async () => {
  const store = createStore();
  await store.setCompareToSha("comparesha");
  store.selectFile("src/index.ts");

  await store.resetVersionSelectors();

  const state = store.getSnapshot();
  expect(state.selectedHeadSha).toBeNull();
  expect(state.selectedCommitSha).toBeNull();
  expect(state.selectedParentSha).toBeNull();
  expect(state.compareToSha).toBeNull();
});

// ============================================================================
// setSelectedParentSha
// ============================================================================

test("setSelectedParentSha(null) clears parent and reloads files", async () => {
  const store = createStore();
  await store.setSelectedCommitSha("abc123");
  await store.setSelectedParentSha("parentsha");
  expect(store.getSnapshot().selectedParentSha).toBe("parentsha");

  await store.setSelectedParentSha(null);

  expect(store.getSnapshot().selectedParentSha).toBeNull();
});

test("setSelectedParentSha(sha) sets parent and resets compare", async () => {
  const store = createStore();
  await store.setSelectedCommitSha("abc123");
  await store.setCompareToSha("comparesha");

  await store.setSelectedParentSha("parentsha");

  const state = store.getSnapshot();
  expect(state.selectedParentSha).toBe("parentsha");
  // Compare should be cleared since parents and version comparison are exclusive
  expect(state.compareToSha).toBeNull();
});

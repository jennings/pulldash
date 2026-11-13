import { expect, test } from "bun:test";
import {
  DEFAULT_MERGE_MESSAGE_SETTINGS as defaults,
  defaultMergeMessage,
} from "./merge-message";

const pr = {
  number: 7,
  title: "Add foo",
  body: "Why foo",
  head: { label: "alice:foo-branch" },
};
const commit = (message: string) => ({ commit: { message } });

test("merge commits default to GitHub's merge message and the PR title", () => {
  expect(defaultMergeMessage("merge", defaults, pr, [])).toEqual({
    title: "Merge pull request #7 from alice/foo-branch",
    message: "Add foo",
  });
});

test("merge commits follow the repository settings", () => {
  expect(
    defaultMergeMessage(
      "merge",
      { ...defaults, mergeTitle: "PR_TITLE", mergeMessage: "PR_BODY" },
      pr,
      []
    )
  ).toEqual({ title: "Add foo (#7)", message: "Why foo" });
});

test("squashing one commit uses that commit", () => {
  expect(
    defaultMergeMessage("squash", defaults, pr, [commit("Do foo\n\nDetails")])
  ).toEqual({ title: "Do foo (#7)", message: "Details" });
});

test("squashing several commits lists them under the PR title", () => {
  expect(
    defaultMergeMessage("squash", defaults, pr, [
      commit("One"),
      commit("Two\n\nMore"),
    ])
  ).toEqual({ title: "Add foo (#7)", message: "* One\n\n* Two\n\nMore" });
});

test("squash settings can pick the PR title and body", () => {
  expect(
    defaultMergeMessage(
      "squash",
      { ...defaults, squashTitle: "PR_TITLE", squashMessage: "PR_BODY" },
      { ...pr, body: null },
      [commit("Do foo")]
    )
  ).toEqual({ title: "Add foo (#7)", message: "" });
});

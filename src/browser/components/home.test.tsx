import { expect, test } from "bun:test";
import { buildSearchQueries } from "./home";

test("buildSearchQueries appends the user's search text after the filter qualifiers", () => {
  const config = {
    repos: [
      { name: "__org__:jj-vcs", mode: "all" as const },
      { name: "owner/repo", mode: "authored" as const },
    ],
  };

  expect(buildSearchQueries(config, "all")).toEqual([
    "is:pr archived:false org:jj-vcs",
    "is:pr archived:false repo:owner/repo author:@me",
  ]);
  expect(
    buildSearchQueries(config, "all", undefined, "  git pull -is:draft ")
  ).toEqual([
    "is:pr archived:false org:jj-vcs git pull -is:draft",
    "is:pr archived:false repo:owner/repo author:@me git pull -is:draft",
  ]);
  expect(buildSearchQueries(config, "all", undefined, "   ")).toEqual(
    buildSearchQueries(config, "all")
  );
});

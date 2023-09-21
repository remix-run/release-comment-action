import fs from "node:fs";
import path from "node:path";
import { execaSync } from "execa";
import { beforeAll, afterAll, expect, describe, test } from "vitest";
import { findMergedPRs, getCommits, getTags } from "../src/lib.js";

let RANDOM_STRING = Math.random().toString(36).substring(7);
let TMP_DIR = `nightly-release-test-${RANDOM_STRING}`;

//////////////////////////////////////////////// SET UP ////////////////////////////////////////////////
// clone the repo
execaSync(
  "git",
  ["clone", "https://github.com/mcansh/nightly-release-test", TMP_DIR],
  { stdio: "inherit" },
);
// fetch git tags
execaSync("git", ["fetch", "--tags"], { stdio: "inherit" });
process.chdir(TMP_DIR);

//////////////////////////////////////////////// TESTS ////////////////////////////////////////////////
test("the whole shooting match", async () => {
  execaSync("git", ["fetch", "--tags"], { stdio: "inherit" });
  let tags = await getTags("@mcansh/nightly-release-test", false);

  expect(tags).toEqual({
    latest: { raw: "@mcansh/nightly-release-test@1.3.2", clean: "1.3.2" },
    previous: { raw: "@mcansh/nightly-release-test@1.3.1", clean: "1.3.1" },
    isNightly: false,
    isStable: true,
    isPreRelease: false,
  });

  let commits = await getCommits(tags.previous, tags.latest, "./packages");
  expect(commits).toHaveLength(3);

  let prs = await findMergedPRs(commits);
  expect(prs).toHaveLength(1);
});

import { execaSync } from "execa";
import { afterAll, beforeAll, expect, test } from "vitest";

import { findMergedPRs, getCommits, getTags } from "../src/lib.js";

//////////////////////////////////////////////// SET UP ////////////////////////////////////////////////
let OWNER = `remix-run` as const;
let REPO = `remix` as const;
let REPOSITORY = `${OWNER}/${REPO}` as const;
let PACKAGE_TO_TRACK = `remix` as const;
let RANDOM_STRING = Math.random().toString(36).substring(7);
let TMP_DIR = `${REPO}-${RANDOM_STRING}`;

let cwd;

beforeAll(() => {
  // clone the repo
  execaSync("git", ["clone", `https://github.com/${REPOSITORY}`, TMP_DIR], {
    stdio: "inherit",
  });
  // fetch git tags
  execaSync("git", ["fetch", "--tags"], { stdio: "inherit" });
  cwd = process.cwd();
  process.chdir(TMP_DIR);
});

afterAll(() => {
  process.chdir(cwd);
  execaSync("rm", ["-rf", TMP_DIR], { stdio: "inherit" });
});

//////////////////////////////////////////////// TESTS ////////////////////////////////////////////////
test("the whole shooting match", async () => {
  execaSync("git", ["fetch", "--tags"], { stdio: "inherit" });
  let tags = await getTags(PACKAGE_TO_TRACK, false);

  expect(tags).toEqual({
    latest: { raw: `remix@2.0.1`, clean: `2.0.1` },
    previous: { raw: `remix@2.0.0`, clean: `2.0.0` },
    isNightly: false,
    isStable: true,
    isPreRelease: false,
  });

  let commits = await getCommits(tags.previous, tags.latest, "./packages");
  expect(commits).toHaveLength(22);

  let prs = await findMergedPRs(commits);
  expect(prs).toHaveLength(16);
});

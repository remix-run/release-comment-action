import type { SyncOptions } from "execa";
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

let cwd: string;

beforeAll(() => {
  let execaOptions: SyncOptions = { stdio: "inherit" };
  let cloneArgs = ["clone", `https://github.com/${REPOSITORY}`, TMP_DIR];
  let fetchArgs = ["fetch", "--tags"];
  // clone the repo
  execaSync("git", cloneArgs, execaOptions);
  // fetch git tags
  execaSync("git", fetchArgs, execaOptions);
  cwd = process.cwd();
  process.chdir(TMP_DIR);

  let currentDate = new Date("2023-09-21T23:31:48.180Z");

  // remove tags prior to 2.0.1
  let tagsToRemove = execaSync("git", [
    "tag",
    "-l",
    "--sort",
    "-creatordate",
    "--format",
    "%(refname:strip=2) %(taggerdate)",
  ])
    .stdout.split("\n")
    .filter((line) => {
      let [, tagTag] = line.split(" ");
      let date = new Date(tagTag);
      return date < currentDate;
    });

  for (let tag of tagsToRemove) {
    console.log(`removing tag ${tag}`);
    execaSync("git", ["tag", "-d", tag]);
  }
});

afterAll(() => {
  process.chdir(cwd);
  execaSync("rm", ["-rf", TMP_DIR], { stdio: "inherit" });
});

//////////////////////////////////////////////// TESTS ////////////////////////////////////////////////
test("the whole shooting match", async () => {
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

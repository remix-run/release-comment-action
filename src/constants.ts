import github from "@actions/github";
import core from "@actions/core";

import { cleanupRef, cleanupTagName, isNightly } from "./utils";

export let DEFAULT_BRANCH = core.getInput("default-branch");
export let NIGHTLY_BRANCH = core.getInput("nightly-branch", { required: true });
let ORIGINAL_VERSION = core.getInput("version", { required: true });

if (!/^refs\/tags\//.test(ORIGINAL_VERSION)) {
  throw new Error("VERSION must start with refs/tags/");
}

export let PACKAGE_VERSION_TO_FOLLOW = core.getInput(
  "package-version-to-follow",
  { required: true }
);

export let AWAITING_RELEASE_LABEL = core.getInput("awaiting-release-label", {
  required: false,
});

export let VERSION = cleanupTagName(cleanupRef(ORIGINAL_VERSION));
export let PR_FILES_STARTS_WITH = ["packages/"];
export let IS_NIGHTLY_RELEASE = isNightly(VERSION);

export let { owner: OWNER, repo: REPO } = github.context.repo;

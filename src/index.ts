// 1. get all remix@ and v0.0.0-nightly-* tags sorted by creation date
// 2. get all commits between current and last tag that changed ./packages using `git`
// 3. check if commit is a PR and get the number,title,body using `gh`
// 4. get issues that are linked in the PR using `gh api`
// 5. comment on PRs and issues with the release version using `gh issue comment` and `gh pr comment`
// 6. close issues that are referenced in the PRs using `gh issue close`

import * as core from "@actions/core";
import { type ExecaReturnValue, execa } from "execa";
import semver from "semver";
import { trimNewlines } from "trim-newlines";
import { z } from "zod";

/*
To run locally, you can provide inputs with `INPUT_` prefixes:

INPUT_DRY_RUN="true" \
INPUT_PACKAGE_NAME="react-router" \
INPUT_DIRECTORY_TO_CHECK="packages/." \
INPUT_GITHUB_REPOSITORY="remix-run/react-router" \
INPUT_INCLUDE_NIGHTLY="false" \
INPUT_ISSUE_LABELS_TO_REMOVE="awaiting release" \
INPUT_ISSUE_LABELS_TO_KEEP_OPEN="🗺️Roadmap" \
node ../release-comment-action/src/index.ts
*/

let PACKAGE_NAME = core.getInput("PACKAGE_NAME");
let DIRECTORY_TO_CHECK = core.getInput("DIRECTORY_TO_CHECK");
let DRY_RUN = core.getBooleanInput("DRY_RUN");
let GITHUB_REPOSITORY = core.getInput("GITHUB_REPOSITORY");
let INCLUDE_NIGHTLY = core.getBooleanInput("INCLUDE_NIGHTLY");
let PR_LABELS_TO_REMOVE = core.getInput("PR_LABELS_TO_REMOVE");
let ISSUE_LABELS_TO_REMOVE = core.getInput("ISSUE_LABELS_TO_REMOVE");
let ISSUE_LABELS_TO_KEEP_OPEN = core.getInput("ISSUE_LABELS_TO_KEEP_OPEN");

// in order to use the `gh` cli that's provided, we need to set the GH_TOKEN
// env variable to the value of the GH_TOKEN input
// not sure if i like it as an input vs having a user have it set in their env
// but at least we can set a default this way...
// doing it the other way would be as follows
/**
  - name: 📝 Comment on issues
    uses: remix-run/release-comment-action
    env:
      GH_TOKEN: ${{ github.token }}
    with:
      PACKAGE_TAGS_TO_FOLLOW: remix
 */
process.env.GH_TOKEN = core.getInput("GH_TOKEN", { required: !DRY_RUN });

if (!PACKAGE_NAME) {
  core.warning("`PACKAGE_NAME` is not set, we'll get all tags");
}

function debug(message: string) {
  console.debug(message);
}

async function main() {
  let { latest, previous, isStable } = await findBoundingTags();

  // Find the git comments between the tags
  let gitCommits = await getCommits(previous, latest);

  // Find any PRs associated with those commits
  let prs = await findMergedPRs(gitCommits);

  let plural = prs.length > 1 ? "s" : "";
  debug(
    `> found ${prs.length} merged PR${plural} that changed ${DIRECTORY_TO_CHECK}`
  );

  // Comment on PRs + comment on/close linked issues
  for (let pr of prs) {
    await commentOnPrAndLinkedIssues(pr, latest, isStable);
  }
}

async function findBoundingTags() {
  // Determine the tags making up the delta from the prior release to this release
  let gitTagsResult = await execCmd(
    "git",
    "tag",
    "-l",
    PACKAGE_NAME ? `${PACKAGE_NAME}@*` : "",
    PACKAGE_NAME && INCLUDE_NIGHTLY ? "v0.0.0-nightly-*" : "",
    "--sort",
    "-creatordate",
    "--format",
    "%(refname:strip=2)"
  );

  if (gitTagsResult.stderr) {
    core.error(gitTagsResult.stderr);
    throw new Error(gitTagsResult.stderr);
  }

  let packageRegex = PACKAGE_NAME ? new RegExp(`^${PACKAGE_NAME}@`) : null;
  let gitTags = gitTagsResult.stdout.split("\n").map((tag) => {
    let clean = packageRegex ? tag.replace(packageRegex, "") : tag;
    return { raw: tag, clean };
  });

  let [latest, previous] = gitTags;

  let isStable = semver.prerelease(latest.clean) === null;
  let isNightly = latest.clean.startsWith("v0.0.0-nightly-");
  let isPreRelease = !isStable && !isNightly;

  // if prerelease && pre.0 OR stable, then we need to get the previous stable version
  // if pre.x, then we need to get the previous pre.x version
  if (isPreRelease) {
    debug(`pre-release: ${latest.clean}`);
    let preRelease = semver.prerelease(latest.clean);

    if (!preRelease || typeof preRelease[1] !== "number") {
      core.error("Unable to parse prerelease");
      throw new Error("Unable to parse prerelease");
    }

    if (preRelease.join(".") === "pre.0") {
      // pre.0 - compare against the prior stable release
      previous = findPreviousStableRelease(latest, gitTags);
      debug(`prior stable: ${previous.clean}`);
    } else {
      // >=pre.1 - compare against the prior prerelease
      let priorTag = latest.raw.replace(
        preRelease.join("."),
        [preRelease[0], preRelease[1] - 1].join(".") // pre.N-1`
      );
      let priorPreRelease = gitTags.find((tag) => tag.raw === priorTag);
      if (priorPreRelease) {
        previous = priorPreRelease;
      } else {
        let err = `Unable to find prior prerelease tag ${priorTag}`;
        core.error(err);
        throw new Error(err);
      }
      debug(`prior pre-release: ${previous.clean}`);
    }
  } else if (isStable) {
    // stable - compare against the prior prerelease
    debug(`stable: ${latest.clean}`);
    previous = findPreviousStableRelease(latest, gitTags);
    debug(`prior stable: ${previous.clean}`);
  } else {
    // nightly - compare against the prior tag which is already in `previous`
    debug(`nightly: ${latest.clean}`);
  }

  debug(
    JSON.stringify({ latest, previous, isPreRelease, isStable, isNightly })
  );

  return { previous, latest, isStable };
}

async function getCommits(from: Tag, to: Tag): Promise<Array<string>> {
  let gitCommitsResult = await execCmd(
    "git",
    "log",
    "--pretty=format:%H",
    `${from.raw}...${to.raw}`,
    DIRECTORY_TO_CHECK!
  );

  if (gitCommitsResult.stderr) {
    core.error(gitCommitsResult.stderr);
    throw new Error(gitCommitsResult.stderr);
  }

  if (gitCommitsResult.stdout.trim() === "") {
    throw new Error("No commits found between tags");
  }

  let gitCommits = gitCommitsResult.stdout.split("\n");
  debug(`> commitCount: ${gitCommits.length}`);
  return gitCommits;
}

async function commentOnPrAndLinkedIssues(
  pr: MergedPR,
  latest: Tag,
  isStable: boolean
) {
  let prComment = `🤖 Hello there,\n\nWe just published version \`${latest.clean}\` which includes this pull request. If you'd like to take it for a test run please try it out and let us know what you think!\n\nThanks!`;

  let promises: Promise<unknown>[] = [];

  debug(`\nPR: https://github.com/${GITHUB_REPOSITORY}/pull/${pr.number}`);

  if (DRY_RUN) {
    debug(`[dry-run] would comment on PR #${pr.number}`);
  } else {
    // Comment on PR
    promises.push(
      execCmd("gh", "pr", "comment", String(pr.number), "--body", prComment)
    );

    // Remove PR labels for stable releases
    if (PR_LABELS_TO_REMOVE && isStable) {
      promises.push(
        execCmd(
          "gh",
          "pr",
          "edit",
          String(pr.number),
          "--remove-label",
          PR_LABELS_TO_REMOVE
        )
      );
    }
  }

  for (let issue of pr.issues) {
    promises.push(commentOnIssue(issue, latest, isStable));
  }

  let results = await Promise.allSettled(promises);
  let failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    core.error(`the following commands failed: ${JSON.stringify(failures)}`);
    throw new Error("failed to comment on PRs and issues");
  }
}

async function commentOnIssue(issue: number, latest: Tag, isStable: boolean) {
  let issueComment = `🤖 Hello there,\n\nWe just published version \`${latest.clean}\` which involves this issue. If you'd like to take it for a test run please try it out and let us know what you think!\n\nThanks!`;

  debug(`Issue: https://github.com/${GITHUB_REPOSITORY}/issues/${issue}`);

  let shouldClose = true;
  if (ISSUE_LABELS_TO_KEEP_OPEN) {
    try {
      let labels = await getIssueLabels(String(issue));
      console.log("Labels on issue #" + issue + ": " + labels.join(", "));
      shouldClose = !labels.includes(ISSUE_LABELS_TO_KEEP_OPEN);
    } catch (err) {
      debug(`⚠️ Unable to get labels for issue #${issue}: ${String(err)}`);
    }
  }

  if (DRY_RUN) {
    debug(`[dry-run] would comment on issue #${issue}`);
    if (shouldClose) {
      debug(`[dry-run] would close issue #${issue}`);
    }
    if (ISSUE_LABELS_TO_REMOVE && isStable) {
      debug(
        `[dry-run] would remove label "${ISSUE_LABELS_TO_REMOVE}" from issue #${issue}`
      );
    }
  } else {
    // Comment on linked issue
    await execCmd(
      "gh",
      "issue",
      "comment",
      String(issue),
      "--body",
      issueComment
    );

    // Close linked issue
    if (shouldClose) {
      await execCmd("gh", "issue", "close", String(issue));
    } else {
      debug(
        `Skipping close of issue #${issue} due to "${ISSUE_LABELS_TO_KEEP_OPEN}" label`
      );
    }

    // Remove labels from linked issue
    if (ISSUE_LABELS_TO_REMOVE && isStable) {
      await execCmd(
        "gh",
        "issue",
        "edit",
        String(issue),
        "--remove-label",
        ISSUE_LABELS_TO_REMOVE
      );
    }
  }
}

function findPreviousStableRelease(tag: Tag, gitTags: Tag[]): Tag {
  let stableTags = getStableTags(gitTags);
  let expectedMajor = semver.major(tag.clean);
  if (semver.minor(tag.clean) === 0 && semver.patch(tag.clean) === 0) {
    expectedMajor -= 1;
  }
  let previous = stableTags.find(
    (t) => t.clean !== tag.clean && semver.major(t.clean) === expectedMajor
  );
  if (!previous) {
    let err = `No previous stable release found for prior major version ${expectedMajor}`;
    core.error(err);
    throw new Error(err);
  }
  return previous;
}

type MergedPR = {
  number: number;
  issues: Array<number>;
};

type Tag = {
  clean: string;
  raw: string;
};

function getStableTags(tags: Array<Tag>): Array<Tag> {
  return tags.filter((tag) => {
    return semver.prerelease(tag.clean) === null;
  });
}

async function getIssuesClosedViaBody(prBody: string): Promise<Array<number>> {
  if (!prBody) return [];

  /**
   * This regex matches for one of github's issue references for auto linking an issue to a PR
   * as that only happens when the PR is sent to the default branch of the repo
   * https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue#linking-a-pull-request-to-an-issue-using-a-keyword
   */
  let regex =
    /(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)(:)?\s#([0-9]+)/gi;

  let matches = prBody.match(regex);
  if (!matches) return [];

  let issuesMatch = matches.map((match) => {
    let [, issueNumber] = match.split(" #");
    return parseInt(issueNumber, 10);
  });

  return issuesMatch;
}

let pullRequestResultSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  body: z.string(),
});

async function findMergedPRs(commits: Array<string>): Promise<MergedPR[]> {
  let CHANGESET_PR_TITLES = [
    "chore: update version for release",
    "chore: update version for release (pre)",
  ];
  let result = await Promise.all(
    commits.map(async (commit) => {
      let prResult = await execCmd(
        "gh",
        "pr",
        "list",
        "--search",
        commit,
        "--state",
        "merged",
        "--json",
        "number,title,url,body"
      );

      if (prResult.stderr) {
        core.error(prResult.stderr);
        throw new Error(prResult.stderr);
      }
      let parsed = JSON.parse(prResult.stdout);

      if (parsed.length === 0) return;

      let pr = parsed[0] ? pullRequestResultSchema.parse(parsed[0]) : null;

      if (!pr) return;

      if (CHANGESET_PR_TITLES.includes(pr.title.toLowerCase())) {
        debug(`skipping changeset PR ${pr.number}`);
        return;
      }

      let linkedIssues = await getIssuesLinkedToPullRequest(pr.url);
      let issuesClosedViaBody = await getIssuesClosedViaBody(pr.body);

      debug(
        JSON.stringify({ pr: pr.number, linkedIssues, issuesClosedViaBody })
      );

      let uniqueIssues = new Set([...linkedIssues, ...issuesClosedViaBody]);

      return {
        number: pr.number,
        issues: [...uniqueIssues],
      };
    })
  );

  return result.filter((pr: any): pr is MergedPR => pr != undefined);
}

let referencedIssueResultSchema = z.object({
  data: z.object({
    resource: z.object({
      closingIssuesReferences: z.object({
        nodes: z.array(z.object({ number: z.number() })),
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable(),
        }),
      }),
    }),
  }),
});

async function getIssuesLinkedToPullRequest(
  prHtmlUrl: string
): Promise<Array<number>> {
  let gql = String.raw;

  let query = gql`
    query ($prHtmlUrl: URI!, $endCursor: String) {
      resource(url: $prHtmlUrl) {
        ... on PullRequest {
          closingIssuesReferences(first: 100, after: $endCursor) {
            nodes {
              number
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  `;

  let result = await execCmd(
    "gh",
    "api",
    "graphql",
    "--paginate",
    "--field",
    `prHtmlUrl=${prHtmlUrl}`,
    "--raw-field",
    `query=${trimNewlines(query)}`
  );

  if (result.stderr) {
    core.error(result.stderr);
    throw new Error(result.stderr);
  }

  debug(result.stdout);

  let parsed = JSON.parse(result.stdout);

  let valid = referencedIssueResultSchema.safeParse(parsed);

  if (!valid.success) {
    core.error(`Unexpected result from graphql query`);
    core.error(JSON.stringify(valid.error));
    throw new Error(`Unexpected result from graphql query`);
  }

  return valid.data.data.resource.closingIssuesReferences.nodes.map(
    (node) => node.number
  );
}

let issueLabelsSchema = z.object({
  data: z.object({
    repository: z.object({
      issue: z.object({
        number: z.number(),
        title: z.string(),
        url: z.string(),
        labels: z.object({
          nodes: z.array(
            z.object({
              name: z.string(),
            })
          ),
        }),
      }),
    }),
  }),
});

async function getIssueLabels(number: string): Promise<Array<string>> {
  let gql = String.raw;

  let query = gql`
    query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          number
          title
          url
          labels(first: 25) {
            nodes {
              name
            }
          }
        }
      }
    }
  `;

  let [owner, repo] = GITHUB_REPOSITORY.split("/");
  let result = await execCmd(
    "gh",
    "api",
    "graphql",
    "--field",
    `owner=${owner}`,
    "--field",
    `repo=${repo}`,
    "--field",
    `number=${number}`,
    "--raw-field",
    `query=${trimNewlines(query)}`
  );

  if (result.stderr) {
    core.error(result.stderr);
    throw new Error(result.stderr);
  }

  debug(result.stdout);

  let parsed = JSON.parse(result.stdout);

  let valid = issueLabelsSchema.safeParse(parsed);

  if (!valid.success) {
    core.error(`Unexpected result from graphql query`);
    core.error(JSON.stringify(valid.error));
    throw new Error(`Unexpected result from graphql query`);
  }

  return valid.data.data.repository.issue.labels.nodes.map((node) => node.name);
}
async function execCmd(
  command: string,
  ..._args: string[]
): Promise<ExecaReturnValue> {
  let args = _args.filter((arg) => arg.length > 0);
  debug(`> ${command} ${args.join(" ")}`);
  let result = await execa(command, args);
  return result;
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    core.setFailed(`Action failed with error ${error}`);
  }
);
